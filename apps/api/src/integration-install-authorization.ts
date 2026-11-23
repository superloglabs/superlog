import { hasOrgManagerAccess, hasProjectManagerAccess } from "./org-authorization.js";

export type IntegrationInstallAuthorization = "authorized" | "forbidden" | "unauthenticated";

export async function authorizeIntegrationInstall(input: {
  authenticatedUserId: string | null;
  initiatingUserId: string;
  preferredOrgId: string | null;
  projectId: string;
  canManageProject(args: {
    userId: string;
    preferredOrgId: string | null;
    projectId: string;
  }): Promise<boolean>;
}): Promise<IntegrationInstallAuthorization> {
  if (!input.authenticatedUserId) return "unauthenticated";
  if (input.authenticatedUserId !== input.initiatingUserId) return "forbidden";
  const canManage = await input.canManageProject({
    userId: input.authenticatedUserId,
    preferredOrgId: input.preferredOrgId,
    projectId: input.projectId,
  });
  return canManage ? "authorized" : "forbidden";
}

export type IntegrationCallbackDependencies = {
  getAuthenticatedUserId(headers: Headers): Promise<string | null>;
  hasProjectManagerAccess(args: {
    userId: string;
    preferredOrgId: string | null;
    projectId: string;
  }): Promise<boolean>;
  hasOrgManagerAccess(args: { userId: string; orgId: string }): Promise<boolean>;
};

async function defaultAuthenticatedUserId(headers: Headers): Promise<string | null> {
  const { getAuthenticatedUserId } = await import("./authenticated-user.js");
  return getAuthenticatedUserId(headers);
}

export function integrationCallbackDependencies(
  overrides: Partial<IntegrationCallbackDependencies> = {},
): IntegrationCallbackDependencies {
  return {
    getAuthenticatedUserId: overrides.getAuthenticatedUserId ?? defaultAuthenticatedUserId,
    hasProjectManagerAccess: overrides.hasProjectManagerAccess ?? hasProjectManagerAccess,
    hasOrgManagerAccess: overrides.hasOrgManagerAccess ?? hasOrgManagerAccess,
  };
}

// A provider callback completes in whichever browser approved the consent
// screen. The install is linked only when that browser is signed in as the
// user who started the connection and that user still manages the project.
export async function authorizeIntegrationCallback(input: {
  headers: Headers;
  initiatingUserId: string | null;
  preferredOrgId: string | null;
  projectId: string;
  dependencies?: Partial<IntegrationCallbackDependencies>;
}): Promise<boolean> {
  if (!input.initiatingUserId) return false;
  const dependencies = integrationCallbackDependencies(input.dependencies);
  const result = await authorizeIntegrationInstall({
    authenticatedUserId: await dependencies.getAuthenticatedUserId(input.headers),
    initiatingUserId: input.initiatingUserId,
    preferredOrgId: input.preferredOrgId,
    projectId: input.projectId,
    canManageProject: dependencies.hasProjectManagerAccess,
  });
  return result === "authorized";
}
