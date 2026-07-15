import { db, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { resolveActiveOrgContext } from "./org-context.js";

export type OrgAccess = {
  userId: string;
  orgId: string;
  role: string;
};

export class OrgAuthorizationError extends Error {
  constructor(readonly code: "no_org" | "manager_required") {
    super(code === "no_org" ? "no org for user" : "org admin access required");
  }
}

export class ProjectAuthorizationError extends Error {
  constructor(readonly code: "not_authenticated" | "project_not_found" | "forbidden") {
    super(code);
  }
}

export function canManageOrg(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function resolveOrgAccess(input: {
  userId: string | undefined;
  preferredOrgId: string | null;
}): Promise<OrgAccess | null> {
  if (!input.userId) return null;
  const ctx = await resolveActiveOrgContext({
    userId: input.userId,
    preferredOrgId: input.preferredOrgId,
  }).catch(() => null);
  if (!ctx) return null;
  const membership = await db.query.orgMembers.findFirst({
    where: and(eq(schema.orgMembers.userId, ctx.user.id), eq(schema.orgMembers.orgId, ctx.org.id)),
    columns: { role: true },
  });
  if (!membership) return null;
  return { userId: ctx.user.id, orgId: ctx.org.id, role: membership.role };
}

export async function requireOrgManagerAccess(input: {
  userId: string | undefined;
  preferredOrgId: string | null;
}): Promise<OrgAccess> {
  const access = await resolveOrgAccess(input);
  if (!access) throw new OrgAuthorizationError("no_org");
  if (!canManageOrg(access.role)) throw new OrgAuthorizationError("manager_required");
  return access;
}

export async function requireProjectManagerAccess(input: {
  userId: string | null | undefined;
  preferredOrgId: string | null;
  projectId: string;
}): Promise<{ access: OrgAccess; project: typeof schema.projects.$inferSelect }> {
  if (!input.userId) throw new ProjectAuthorizationError("not_authenticated");
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, input.projectId),
  });
  if (!project) throw new ProjectAuthorizationError("project_not_found");
  const membership = await db.query.orgMembers.findFirst({
    where: and(
      eq(schema.orgMembers.userId, input.userId),
      eq(schema.orgMembers.orgId, project.orgId),
    ),
    columns: { role: true },
  });
  if (!membership || !canManageOrg(membership.role)) {
    throw new ProjectAuthorizationError("forbidden");
  }
  const access = { userId: input.userId, orgId: project.orgId, role: membership.role };
  return { access, project };
}

export async function hasProjectManagerAccess(input: {
  userId: string | null | undefined;
  preferredOrgId: string | null;
  projectId: string;
}): Promise<boolean> {
  try {
    await requireProjectManagerAccess(input);
    return true;
  } catch (error) {
    if (error instanceof ProjectAuthorizationError) return false;
    throw error;
  }
}
