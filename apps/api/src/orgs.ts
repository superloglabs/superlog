import { db, resolveDefaultAgentRunProvider, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";

type Vars = { userId: string; orgId: string | null };

// The transaction handle drizzle passes to `db.transaction(async (tx) => …)`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Postgres unique-constraint violation. drizzle/postgres-js surfaces the raw
// SQLSTATE either directly on the error or on its `cause`.
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: unknown }).code;
  const nested = (err as { cause?: { code?: unknown } }).cause?.code;
  return direct === "23505" || nested === "23505";
}

export const ORG_NAME_MAX = 80;

export function slugifyOrgName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function uniqueOrgSlug(
  client: Pick<typeof db, "query">,
  base: string,
): Promise<string> {
  const seed = base || "org";
  let candidate = seed;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = await client.query.orgs.findFirst({ where: eq(schema.orgs.slug, candidate) });
    if (!existing) return candidate;
    candidate = `${seed.slice(0, 32)}-${nanoid(6).toLowerCase()}`;
  }
  return `${seed.slice(0, 20)}-${nanoid(12).toLowerCase()}`;
}

// Creates an org with the caller as owner plus a "Default" project and its
// automation settings — the shared core behind both first-org onboarding
// (POST /api/me/orgs) and creating additional orgs (POST /api/orgs). Must run
// inside a transaction so a failure rolls the whole thing back.
export async function createOrgWithDefaults(
  tx: Tx,
  input: { userId: string; name: string },
): Promise<{
  org: typeof schema.orgs.$inferSelect;
  project: typeof schema.projects.$inferSelect;
}> {
  // uniqueOrgSlug pre-checks for a free slug, but two concurrent creates can
  // still pick the same slug between the check and the insert. Retry on the
  // resulting unique-violation with a fresh suffixed slug, each attempt inside
  // a SAVEPOINT (nested tx) so a failed insert rolls back just that attempt
  // instead of poisoning the whole org-creation transaction.
  const base = slugifyOrgName(input.name) || "org";
  let org: typeof schema.orgs.$inferSelect | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug =
      attempt === 0
        ? await uniqueOrgSlug(tx, base)
        : `${base.slice(0, 32)}-${nanoid(6).toLowerCase()}`;
    try {
      org = await tx.transaction(async (sp) => {
        const [row] = await sp.insert(schema.orgs).values({ name: input.name, slug }).returning();
        return row;
      });
      break;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) continue;
      throw err;
    }
  }
  if (!org) throw new HTTPException(500, { message: "failed to create org" });

  await tx
    .insert(schema.orgMembers)
    .values({ orgId: org.id, userId: input.userId, role: "owner" })
    .onConflictDoNothing({ target: [schema.orgMembers.orgId, schema.orgMembers.userId] });

  const [project] = await tx
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  if (!project) throw new HTTPException(500, { message: "failed to create default project" });

  await tx
    .insert(schema.projectAutomationSettings)
    .values({ projectId: project.id, agentRunProvider: resolveDefaultAgentRunProvider() })
    .onConflictDoNothing({ target: schema.projectAutomationSettings.projectId });

  return { org, project };
}

export function mountOrgCrud(app: Hono<{ Variables: Vars }>) {
  // Create an additional organization. Unlike POST /api/me/orgs (idempotent
  // first-org onboarding), this always creates a fresh org. The web client
  // calls authClient.organization.setActive() afterwards to switch into it, so
  // we don't touch sessions or fire the onboarding-only Loops welcome flow.
  app.post("/api/orgs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    if (!rawName) throw new HTTPException(400, { message: "name required" });
    if (rawName.length > ORG_NAME_MAX) {
      throw new HTTPException(400, { message: `name must be ${ORG_NAME_MAX} chars or fewer` });
    }

    const userId = c.var.userId;
    const { org, project } = await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for("update");
      if (!user) throw new HTTPException(404, { message: "user not found" });
      return createOrgWithDefaults(tx, { userId, name: rawName });
    });

    return c.json({
      org: { id: org.id, name: org.name, slug: org.slug },
      project: { id: project.id, name: project.name, slug: project.slug },
    });
  });

  // Delete an organization. Owner-only, and never the caller's last org.
  app.delete("/api/orgs/:orgId", async (c) => {
    const userId = c.var.userId;
    const orgId = c.req.param("orgId");

    const result = await db.transaction(async (tx) => {
      // Lock *every* membership this user has, up front, and decide from the
      // locked set. This serializes concurrent deletes by the same user, so two
      // requests deleting two different orgs can't both pass the last-org guard
      // and leave the user with zero orgs. Locking only the target org row
      // wouldn't help — deletes of different orgs take non-conflicting locks.
      // The unique (org_id, user_id) index means one row per org the caller is in.
      const memberships = await tx
        .select({ orgId: schema.orgMembers.orgId, role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .where(eq(schema.orgMembers.userId, userId))
        .for("update");

      const membership = memberships.find((m) => m.orgId === orgId);
      // Don't leak the existence of orgs the caller can't see.
      if (!membership) return { status: 404 as const, body: { error: "organization not found" } };
      if (membership.role !== "owner") {
        return {
          status: 403 as const,
          body: { error: "only an owner can delete an organization" },
        };
      }
      // Every user keeps at least one org — mirror the "cannot delete the last
      // project in an org" guard.
      if (memberships.length <= 1) {
        return {
          status: 409 as const,
          body: { error: "cannot delete your only organization" },
        };
      }

      // Cascades clean up members, projects (+ all their children), invitations,
      // org API keys, integrations, GitHub installs, and agent memories/settings.
      // users.activeOrgId/favoriteOrgId and sessions.activeOrganizationId are
      // SET NULL, so the caller's next /api/me re-resolves an active org via the
      // favorite > last-used > first precedence.
      // NOTE: the org's Autumn billing customer (when billing is configured) is
      // intentionally NOT torn down here — orphaned-customer cleanup is a tracked
      // follow-up, out of scope for self-serve delete.
      await tx.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      return { status: 200 as const, body: { ok: true } };
    });

    return c.json(result.body, result.status);
  });
}
