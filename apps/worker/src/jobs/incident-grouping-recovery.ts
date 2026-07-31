import { runIssueGroupingRecoverySweep } from "../incident-grouping-recovery/sweep.js";
import { handleIssueTransition } from "../incidents/workflow.js";
import { findStaleUngroupedIssues } from "../issues/repository.js";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

const RECOVERY_BATCH_SIZE = 100;

export function createIncidentGroupingRecoveryJob(
  options: { run?: (deps: JobDeps) => Promise<number> } = {},
): JobDefinition {
  return {
    name: "incident-grouping-recovery",
    schedule: "* * * * *",
    create: (deps) => async () => {
      if (options.run) {
        await options.run(deps);
        return;
      }
      await runIssueGroupingRecoverySweep({
        now: () => new Date(),
        listCandidates: (cutoff) =>
          findStaleUngroupedIssues(
            { attemptedBefore: cutoff, limit: RECOVERY_BATCH_SIZE },
            deps.db,
          ),
        retry: (issue) => handleIssueTransition(issue, "new"),
        logger,
      });
    },
  };
}

export const job = createIncidentGroupingRecoveryJob();
