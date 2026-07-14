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
  findOpenRecurrenceForIncident,
  findProject,
  linkIssueToIncident,
  loadLinkedIncidentIssues,
  reopenIssue,
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
      findOpenRecurrenceForIncident,
      reopenIssue,
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
    // incident for what should be one. The workflow keys new issues by trace id
    // when present, otherwise by issue id; recurrences acquire both predecessor
    // and trace keys when available so overlapping correlation boundaries all
    // converge. The LLM grouping call stays outside the hook; notifications
    // happen in the caller after release.
    serializeCreate: withIssueIntakeLock,
  });
}
