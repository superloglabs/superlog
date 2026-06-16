import { db, schema } from "@superlog/db";
import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

export type AccessibleProject = {
  id: string;
  name: string;
  slug: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
};

export async function listAccessibleProjects(userId: string): Promise<AccessibleProject[]> {
  const memberships = await db.query.orgMembers.findMany({
    where: eq(schema.orgMembers.userId, userId),
  });
  if (memberships.length === 0) return [];
  const orgIds = memberships.map((m) => m.orgId);

  const orgs = await db.query.orgs.findMany({
    where: inArray(schema.orgs.id, orgIds),
  });
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  const projects = await db.query.projects.findMany({
    where: inArray(schema.projects.orgId, orgIds),
  });

  return projects
    .map((p) => {
      const o = orgById.get(p.orgId);
      if (!o) return null;
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        orgId: o.id,
        orgName: o.name,
        orgSlug: o.slug,
      };
    })
    .filter((x): x is AccessibleProject => x !== null);
}

export async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
  });
  if (!project) throw new HTTPException(404, { message: "project not found" });

  const membership = await db.query.orgMembers.findFirst({
    where: and(eq(schema.orgMembers.userId, userId), eq(schema.orgMembers.orgId, project.orgId)),
  });
  if (!membership) throw new HTTPException(403, { message: "no access to project" });
}

export async function setActiveProjectForToken(
  tokenId: string,
  userId: string,
  projectId: string,
  tokenKind: "oauth" | "pat" = "oauth",
): Promise<AccessibleProject> {
  await assertProjectAccess(userId, projectId);
  if (tokenKind === "pat") {
    await db
      .update(schema.personalAccessTokens)
      .set({ projectId })
      .where(eq(schema.personalAccessTokens.id, tokenId));
  } else {
    await db
      .update(schema.mcpOauthTokens)
      .set({ projectId })
      .where(eq(schema.mcpOauthTokens.id, tokenId));
  }

  const projects = await listAccessibleProjects(userId);
  const found = projects.find((p) => p.id === projectId);
  if (!found) throw new HTTPException(500, { message: "project vanished after switch" });
  return found;
}
