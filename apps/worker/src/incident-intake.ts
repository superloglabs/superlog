// Thin facade. The workflow lives in `incidents/intake.ts` with all
// collaborators injected; this file wires the real db / lifecycle /
// grouping client and re-exports the existing public surface.
import { createIncidentLifecycle, db, type schema } from "@superlog/db";
import { analyzeIssueGrouping } from "./grouping.js";
import type { EnsureIncidentForIssueResult, IssueIntakeTransition } from "./incidents/intake.js";
import { ensureIncidentForIssueWorkflow } from "./incidents/intake.js";
import {
  findAlertEpisodeForIssue,
  findIncident,
  findLatestIncidentForAlert,
  findLatestIncidentIssueLink,
  findOpenIncidentCandidates,
  findOpenIncidentForAlert,
  findProject,
  linkIssueToIncident,
  loadLinkedIncidentIssues,
  touchIncidentLastSeen,
  updateIssueGrouping,
  withIssueIntakeLock,
} from "./issues/repository.js";
import { logger } from "./logger.js";

const incidentLifecycle = createIncidentLifecycle(db);

export type { LinkedIncidentIssue } from "./issues/domain.js";
export type { EnsureIncidentForIssueResult, IssueIntakeTransition } from "./incidents/intake.js";
export { loadLinkedIncidentIssues } from "./issues/repository.js";

export async function ensureIncidentForIssue(
  issue: schema.Issue,
  transition: IssueIntakeTransition,
): Promise<EnsureIncidentForIssueResult> {
  return ensureIncidentForIssueWorkflow(issue, transition, {
    repo: {
      findLatestIncidentIssueLink,
      findIncident,
      findAlertEpisodeForIssue,
      findOpenIncidentForAlert,
      findLatestIncidentForAlert,
      findOpenIncidentCandidates,
      loadLinkedIncidentIssues,
      findProject,
      linkIssueToIncident,
      touchIncidentLastSeen,
      updateIssueGrouping,
    },
    lifecycle: incidentLifecycle,
    analyzeGrouping: analyzeIssueGrouping,
    logger,
    // Alert-episode issues are the one path where concurrent duplicates of the
    // SAME issue can reach intake together (racing evaluations fold into one
    // episode issue and both proceed): serialize the workflow's create/link
    // section with a per-issue advisory lock so the second racer re-lands on
    // the first's incident. The workflow keeps the LLM grouping call outside
    // the hook; notifications and agent queueing happen in the caller, after
    // the lock is released. Error ingest doesn't need this — its transition
    // classification already picks a single notifier per occurrence.
    serializeCreate: issue.kind === "alert" ? withIssueIntakeLock : undefined,
  });
}
