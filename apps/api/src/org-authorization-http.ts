import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  OrgAuthorizationError,
  ProjectAuthorizationError,
  requireOrgManagerAccess,
  requireProjectManagerAccess,
} from "./org-authorization.js";

export type AuthorizationVars = { userId: string; orgId: string | null };

export async function requireOrgManagerContext(c: Context<{ Variables: AuthorizationVars }>) {
  try {
    return await requireOrgManagerAccess({
      userId: c.var.userId,
      preferredOrgId: c.var.orgId,
    });
  } catch (error) {
    if (error instanceof OrgAuthorizationError) {
      throw new HTTPException(error.code === "no_org" ? 404 : 403, { message: error.message });
    }
    throw error;
  }
}

export async function requireProjectManagerContext(
  c: Context<{ Variables: AuthorizationVars }>,
  projectId: string,
) {
  try {
    return await requireProjectManagerAccess({
      userId: c.var.userId,
      preferredOrgId: c.var.orgId,
      projectId,
    });
  } catch (error) {
    if (error instanceof ProjectAuthorizationError) {
      if (error.code === "not_authenticated") {
        throw new HTTPException(401, { message: "not authenticated" });
      }
      if (error.code === "project_not_found") {
        throw new HTTPException(404, { message: "project not found" });
      }
      throw new HTTPException(403, { message: "forbidden" });
    }
    throw error;
  }
}
