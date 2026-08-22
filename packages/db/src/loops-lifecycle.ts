// Pure Loops lifecycle derivation. No DB or network imports, so the mapping is
// unit-testable in isolation (the existing db unit tests never import the DB
// client). The actual DB reads live in loops.ts's
// fetchLoopsLifecycleForUserProject, which feeds the timestamps in here.

export type LoopsLifecycle = {
  telemetrySet: boolean;
  telemetrySetAt: string | null;
  githubAdded: boolean;
  githubAddedAt: string | null;
  slackAdded: boolean;
  slackAddedAt: string | null;
  mcpInstalled: boolean;
  mcpInstalledAt: string | null;
  // Whether the agent has opened at least one fix (a PR) for the org, and
  // whether the org's first such fix has been merged. Drives re-engagement:
  // "connected a repo but no fix yet" is githubAdded && !fixStarted.
  fixStarted: boolean;
  fixStartedAt: string | null;
  fixMerged: boolean;
  fixMergedAt: string | null;
};

/**
 * Turn the raw per-signal "first seen" timestamps into the boolean + timestamp
 * pairs Loops stores as contact properties. A null timestamp means the signal
 * hasn't happened yet; a set one means it has.
 */
export function deriveLifecycle(ats: {
  telemetrySetAt: string | null;
  githubAddedAt: string | null;
  slackAddedAt: string | null;
  mcpInstalledAt: string | null;
  fixStartedAt: string | null;
  fixMergedAt: string | null;
}): LoopsLifecycle {
  return {
    telemetrySet: ats.telemetrySetAt !== null,
    telemetrySetAt: ats.telemetrySetAt,
    githubAdded: ats.githubAddedAt !== null,
    githubAddedAt: ats.githubAddedAt,
    slackAdded: ats.slackAddedAt !== null,
    slackAddedAt: ats.slackAddedAt,
    mcpInstalled: ats.mcpInstalledAt !== null,
    mcpInstalledAt: ats.mcpInstalledAt,
    fixStarted: ats.fixStartedAt !== null,
    fixStartedAt: ats.fixStartedAt,
    fixMerged: ats.fixMergedAt !== null,
    fixMergedAt: ats.fixMergedAt,
  };
}
