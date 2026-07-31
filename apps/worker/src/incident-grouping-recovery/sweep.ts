import type { schema } from "@superlog/db";

export const ISSUE_GROUPING_RETRY_DELAY_MS = 60_000;

export type IssueGroupingRecoverySweepDeps = {
  now(): Date;
  listCandidates(cutoff: Date): Promise<schema.Issue[]>;
  retry(issue: schema.Issue): Promise<void>;
  logger: {
    error(context: Record<string, unknown>, message: string): void;
  };
};

export async function runIssueGroupingRecoverySweep(
  deps: IssueGroupingRecoverySweepDeps,
): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - ISSUE_GROUPING_RETRY_DELAY_MS);
  const candidates = await deps.listCandidates(cutoff);
  let retriedCount = 0;

  for (const issue of candidates) {
    try {
      await deps.retry(issue);
      retriedCount += 1;
    } catch (err) {
      deps.logger.error(
        {
          scope: "incident-grouping-recovery",
          issue_id: issue.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to recover ungrouped issue",
      );
    }
  }

  return retriedCount;
}
