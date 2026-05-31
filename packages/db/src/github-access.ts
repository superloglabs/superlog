import { and, eq, isNull } from "drizzle-orm";
import { db } from "./client.js";
import { githubInstallations, projectGithubRepos } from "./schema.js";
import type { GithubInstallation } from "./schema.js";

// An install a project can use, plus the set of repos the project is allowed
// to touch via that install:
//   allowedRepoIds: null  → project owns the install; all repos in the
//                           install are usable (the install row's existing
//                           repoAccess.disabledRepoIds still applies on top).
//   allowedRepoIds: array → project accesses an org-scoped install via
//                           explicit grants in project_github_repos; only
//                           these GitHub repo IDs are usable.
export type AccessibleGithubInstall = {
  installation: GithubInstallation;
  allowedRepoIds: number[] | null;
};

// Returns every GitHub install a project can use:
//   - Project-scoped installs the project directly owns
//     (github_installations.project_id = projectId, not revoked).
//   - Plus any org-scoped install the project has grants on
//     (project_github_repos rows pointing at non-revoked installs), with
//     the granted GitHub repo IDs attached.
//
// Revoked installs are excluded from both sources. An install can show up
// only once: if a project both owns an install and somehow has grant rows
// on it, the owned entry wins (allowedRepoIds = null = "all repos").
export async function listAccessibleGithubInstallsForProject(
  projectId: string,
): Promise<AccessibleGithubInstall[]> {
  const owned = await db.query.githubInstallations.findMany({
    where: and(
      eq(githubInstallations.projectId, projectId),
      isNull(githubInstallations.revokedAt),
    ),
  });
  const ownedIds = new Set(owned.map((row) => row.id));

  const grantedRows = await db
    .select({
      installation: githubInstallations,
      repoId: projectGithubRepos.githubRepoId,
    })
    .from(projectGithubRepos)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, projectGithubRepos.installationId),
    )
    .where(
      and(
        eq(projectGithubRepos.projectId, projectId),
        isNull(githubInstallations.revokedAt),
      ),
    );

  const grantedByInstallId = new Map<string, AccessibleGithubInstall>();
  for (const row of grantedRows) {
    if (ownedIds.has(row.installation.id)) continue; // owned beats granted
    let entry = grantedByInstallId.get(row.installation.id);
    if (!entry) {
      entry = { installation: row.installation, allowedRepoIds: [] };
      grantedByInstallId.set(row.installation.id, entry);
    }
    entry.allowedRepoIds!.push(row.repoId);
  }

  return [
    ...owned.map((installation) => ({ installation, allowedRepoIds: null })),
    ...Array.from(grantedByInstallId.values()),
  ];
}
