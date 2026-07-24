export function suggestedOrgName({
  workspaceOrgName,
  userName,
  userEmail,
}: {
  workspaceOrgName?: string | null;
  userName: string;
  userEmail: string;
}): string {
  const trimmedWorkspaceName = workspaceOrgName?.trim();
  if (trimmedWorkspaceName) return trimmedWorkspaceName;

  const trimmedName = userName.trim();
  if (trimmedName) return `${trimmedName}'s org`;

  const local = userEmail.split("@")[0] ?? "";
  if (local) return `${local}'s org`;

  return "";
}
