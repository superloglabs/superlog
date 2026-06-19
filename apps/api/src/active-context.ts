// Pure decision helpers for "what org/project should be active". These encode
// the precedence rules; the db-backed wiring lives in auth.ts (session seeding)
// and org-context.ts (per-request resolution). Keeping the rules pure makes the
// precedence unit-testable without a database.

// Picks the org to make active when a fresh session starts. Precedence:
//   1. the user's pinned favorite org (if they're still a member)
//   2. the org they last had active (if they're still a member)
//   3. their first/oldest membership
// Returns null only when the user has no memberships at all (pre-org user).
export function pickActiveOrgId(input: {
  favoriteOrgId: string | null;
  lastUsedOrgId: string | null;
  memberOrgIds: string[];
}): string | null {
  const { favoriteOrgId, lastUsedOrgId, memberOrgIds } = input;
  const members = new Set(memberOrgIds);
  if (favoriteOrgId && members.has(favoriteOrgId)) return favoriteOrgId;
  if (lastUsedOrgId && members.has(lastUsedOrgId)) return lastUsedOrgId;
  return memberOrgIds[0] ?? null;
}

// Decides whether a fresh session should be seeded onto the user's pinned
// favorite project. The favorite only applies when the org we just made active
// is the favorite's own org — otherwise we leave the last-used project in place
// and let downstream resolution fall back to last-used / first project. Returns
// the project id to seed, or null to leave the stored last-used value untouched.
export function favoriteProjectToSeed(input: {
  favoriteProjectId: string | null;
  favoriteOrgId: string | null;
  activeOrgId: string | null;
}): string | null {
  const { favoriteProjectId, favoriteOrgId, activeOrgId } = input;
  if (!favoriteProjectId || !favoriteOrgId) return null;
  if (favoriteOrgId !== activeOrgId) return null;
  return favoriteProjectId;
}
