import { db, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveMaybeActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; sessionId?: string; orgId: string | null };

export function mountProjectRouteContext(app: Hono<{ Variables: Vars }>) {
  // Resolve an org's canonical route (its slug + a project slug) for a member,
  // WITHOUT mutating the session. The org/project switcher calls this to build
  // the destination URL for a cross-org switch, then navigates there and lets
  // ProjectRouteBoundary move the active org to match the URL. Keeping this
  // read-only is what makes the switch race-free: the session only changes once
  // the URL already names the target org, so there's no transient mismatch to
  // reconcile backwards.
  app.get("/api/me/org-route", async (c) => {
    const orgId = c.req.query("orgId")?.trim();
    if (!orgId) throw new HTTPException(400, { message: "orgId required" });

    const ctx = await resolveMaybeActiveOrgContext({
      userId: c.var.userId,
      preferredOrgId: orgId,
    });
    // resolveMaybeActiveOrgContext falls back to the user's first membership
    // when `orgId` isn't one of theirs, so confirm it actually resolved the
    // requested org. A non-member and a missing org look identical.
    if (!ctx.org || ctx.org.id !== orgId) {
      throw new HTTPException(404, { message: "organization not found" });
    }

    return c.json({ orgSlug: ctx.org.slug, projectSlug: ctx.project.slug });
  });

  app.put("/api/me/active-context", async (c) => {
    const sessionId = c.var.sessionId;
    if (!sessionId) throw new HTTPException(401, { message: "authenticated session required" });
    const body = (await c.req.json().catch(() => ({}))) as {
      orgSlug?: unknown;
      projectSlug?: unknown;
    };
    const orgSlug = typeof body.orgSlug === "string" ? body.orgSlug.trim() : "";
    const projectSlug = typeof body.projectSlug === "string" ? body.projectSlug.trim() : "";
    if (!orgSlug || !projectSlug) {
      throw new HTTPException(400, { message: "orgSlug and projectSlug required" });
    }

    const selected = await db.transaction(async (tx) => {
      const [context] = await tx
        .select({
          orgId: schema.orgs.id,
          orgName: schema.orgs.name,
          orgSlug: schema.orgs.slug,
          projectId: schema.projects.id,
          projectName: schema.projects.name,
          projectSlug: schema.projects.slug,
        })
        .from(schema.orgMembers)
        .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
        .innerJoin(schema.projects, eq(schema.projects.orgId, schema.orgs.id))
        .where(
          and(
            eq(schema.orgMembers.userId, c.var.userId),
            eq(schema.orgs.slug, orgSlug),
            eq(schema.projects.slug, projectSlug),
          ),
        )
        .limit(1);

      if (!context) return null;

      await tx
        .update(schema.sessions)
        .set({ activeOrganizationId: context.orgId })
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, c.var.userId)));
      await tx
        .update(schema.users)
        .set({ activeOrgId: context.orgId, activeProjectId: context.projectId })
        .where(eq(schema.users.id, c.var.userId));

      return context;
    });

    if (!selected) {
      // A missing route and an inaccessible route deliberately look identical.
      throw new HTTPException(404, { message: "organization or project not found" });
    }

    return c.json({
      org: { id: selected.orgId, name: selected.orgName, slug: selected.orgSlug },
      project: {
        id: selected.projectId,
        name: selected.projectName,
        slug: selected.projectSlug,
      },
    });
  });
}
