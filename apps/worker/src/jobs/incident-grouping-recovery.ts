import { metrics } from "@opentelemetry/api";
import { runIssueGroupingRecoverySweep } from "../incident-grouping-recovery/sweep.js";
import { handleIssueTransition } from "../incidents/workflow.js";
import { findStaleUngroupedIssues } from "../issues/repository.js";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

const RECOVERY_BATCH_SIZE = 100;
const meter = metrics.getMeter("@superlog/worker/incident-grouping-recovery");
const recoveredIssueCounter = meter.createCounter(
  "superlog.incident_grouping_recovery.recovered_issues",
  { description: "Issues successfully retried by the incident grouping recovery sweep" },
);

export function createIncidentGroupingRecoveryJob(
  options: {
    run?: (deps: JobDeps) => Promise<number>;
    recordRecovered?: (count: number) => void;
  } = {},
): JobDefinition {
  return {
    name: "incident-grouping-recovery",
    schedule: "* * * * *",
    create: (deps) => async () => {
      let recoveredCount: number;
      if (options.run) {
        recoveredCount = await options.run(deps);
      } else {
        recoveredCount = await runIssueGroupingRecoverySweep({
          now: () => new Date(),
          listCandidates: (cutoff) =>
            findStaleUngroupedIssues(
              { attemptedBefore: cutoff, limit: RECOVERY_BATCH_SIZE },
              deps.db,
            ),
          retry: (issue) => handleIssueTransition(issue, "new"),
          logger,
        });
      }
      (options.recordRecovered ?? ((count) => recoveredIssueCounter.add(count)))(recoveredCount);
    },
  };
}

export const job = createIncidentGroupingRecoveryJob();
