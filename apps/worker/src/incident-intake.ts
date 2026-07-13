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
    // Serialize the workflow's read-then-create section with an advisory lock so
    // concurrent intakes (pg-boss issue-transition jobs) can't each open an
    // incident for what should be one. The workflow keys the lock by trace id
    // when present — same-request symptoms (a span exception and its own log
    // line) are DIFFERENT issues, so a per-issue lock wouldn't serialize them —
    // and re-checks the same-trace match inside the lock so the loser re-lands on
    // the winner's incident. Falls back to the issue id (the alert-episode case:
    // racing evaluations fold into one episode issue). The LLM grouping call
    // stays outside the hook; notifications happen in the caller after release.
    serializeCreate: withIssueIntakeLock,
  });
}
