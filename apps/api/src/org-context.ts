import { db, resolveDefaultAgentRunProvider, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";

// Org context resolution backed by Better Auth's session + organization
// plugin. Replaces the old Clerk-driven resolveActiveOrgContext in
// clerk-orgs.ts: identity now comes from our local `users` + `org_members`
// tables, so this is a pure DB read with no upstream sync calls.

type SyncedUser = typeof schema.users.$inferSelect;
type SyncedOrg = typeof schema.orgs.$inferSelect;
type SyncedProject = typeof schema.projects.$inferSelect;

type ResolveActiveOrgOptions = {
  userId: string;
  preferredOrgId?: string | null;
  preferredProjectId?: string | null;
};

export type ActiveOrgContext = {
  user: SyncedUser;
  org: SyncedOrg;
  project: SyncedProject;
};

export type MaybeActiveOrgContext =
  | ActiveOrgContext
  | { user: SyncedUser; org: null; project: null };

async function ensureProjectForOrg(orgId: string): Promise<SyncedProject> {
  const existing = await db.query.projects.findFirst({
    where: eq(schema.projects.orgId, orgId),
  });
  if (existing) return existing;

  const inserted = await db
    .insert(schema.projects)
    .values({ orgId, name: "Default", slug: "default" })
    .returning();
  const project = inserted[0];
  if (!project) throw new Error("failed to create default project");

  await db
    .insert(schema.projectAutomationSettings)
    .values({ projectId: project.id, agentRunProvider: resolveDefaultAgentRunProvider() })
    .onConflictDoNothing({ target: schema.projectAutomationSettings.projectId });

  return project;
}

async function resolveProjectForOrg(
  orgId: string,
  preferredProjectId: string | null,
): Promise<SyncedProject> {
  if (preferredProjectId) {
    const candidate = await db.query.projects.findFirst({
      where: and(eq(schema.projects.id, preferredProjectId), eq(schema.projects.orgId, orgId)),
    });
    if (candidate) return candidate;
  }
  return ensureProjectForOrg(orgId);
}

// Returns the user's active org + project, or `org: null, project: null` when
// the user hasn't created their first org yet. Use this on endpoints that
// must keep working for pre-org users (currently only /api/me — every other
// endpoint requires an org and uses resolveActiveOrgContext).
export async function resolveMaybeActiveOrgContext(
  options: ResolveActiveOrgOptions,
): Promise<MaybeActiveOrgContext> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, options.userId) });
  if (!user) throw new Error(`user ${options.userId} not found`);

  const preferredProjectId = options.preferredProjectId ?? user.activeProjectId ?? null;

  if (options.preferredOrgId) {
    const membership = await db.query.orgMembers.findFirst({
      where: and(
        eq(schema.orgMembers.userId, options.userId),
        eq(schema.orgMembers.orgId, options.preferredOrgId),
      ),
    });
    if (membership) {
      const org = await db.query.orgs.findFirst({ where: eq(schema.orgs.id, membership.orgId) });
      if (org) {
        const project = await resolveProjectForOrg(org.id, preferredProjectId);
        return { user, org, project };
      }
    }
  }

  const firstMembership = await db.query.orgMembers.findFirst({
    where: eq(schema.orgMembers.userId, options.userId),
  });

  if (!firstMembership) return { user, org: null, project: null };

  const org = await db.query.orgs.findFirst({ where: eq(schema.orgs.id, firstMembership.orgId) });
  if (!org) throw new Error("org membership references missing org");
  const project = await resolveProjectForOrg(org.id, preferredProjectId);
  return { user, org, project };
}

export async function resolveActiveOrgContext(
  options: ResolveActiveOrgOptions,
): Promise<ActiveOrgContext> {
  const ctx = await resolveMaybeActiveOrgContext(options);
  if (!ctx.org) throw new Error("no organization access");
  return ctx;
}
