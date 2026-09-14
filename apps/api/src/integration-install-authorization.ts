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
