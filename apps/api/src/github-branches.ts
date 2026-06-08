import { normalizePrBaseBranch } from "@superlog/db/schema";

export type RepoBranch = { name: string; isDefault: boolean };

export type RepoBranchInfo = { defaultBranch: string | null; branches: string[] };

// Pure: collapse the per-repo branch lists of a project into one deduped,
// sorted set for the config dropdown. A name is `isDefault` if it's the
// default branch of ANY repo. The default branch is always included even if
// the paginated branch list didn't surface it. Defaults sort first, then
// alphabetical — so the most likely target is at the top of the picker.
export function mergeRepoBranches(perRepo: RepoBranchInfo[]): RepoBranch[] {
  const names = new Set<string>();
  const defaults = new Set<string>();
  for (const repo of perRepo) {
    for (const raw of repo.branches) {
      const name = raw.trim();
      if (name) names.add(name);
    }
    const def = repo.defaultBranch?.trim();
    if (def) {
      names.add(def);
      defaults.add(def);
    }
  }
  return [...names]
    .map((name) => ({ name, isDefault: defaults.has(name) }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// Pure: a configured PR base branch is valid if it's blank (meaning "use the
// repository default") or it matches a branch that actually exists in one of
// the project's repos.
export function prBaseBranchExists(
  candidate: string | null | undefined,
  branches: RepoBranch[],
): boolean {
  const normalized = normalizePrBaseBranch(candidate);
  if (!normalized) return true;
  return branches.some((branch) => branch.name === normalized);
}
