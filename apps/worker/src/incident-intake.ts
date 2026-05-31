// Thin facade. The workflow lives in `incidents/intake.ts` with all
// collaborators injected; this file wires the real db / lifecycle /
// grouping client and re-exports the existing public surface.
import { createIncidentLifecycle, db, type schema } from "@superlog/db";
import { analyzeIssueGrouping } from "./grouping.js";
import type { EnsureIncidentForIssueResult } from "./incidents/intake.js";
import { ensureIncidentForIssueWorkflow } from "./incidents/intake.js";
import {
  findIncident,
  findIncidentIssueLink,
  findOpenIncidentCandidates,
  findProject,
  linkIssueToIncident,
  loadLinkedIncidentIssues,
  updateIssueGrouping,
} from "./issues/repository.js";
import { logger } from "./logger.js";

const incidentLifecycle = createIncidentLifecycle(db);

export type { LinkedIncidentIssue } from "./issues/domain.js";
export type { EnsureIncidentForIssueResult } from "./incidents/intake.js";
export { loadLinkedIncidentIssues } from "./issues/repository.js";

export async function ensureIncidentForIssue(
  issue: schema.Issue,
): Promise<EnsureIncidentForIssueResult> {
  return ensureIncidentForIssueWorkflow(issue, {
    repo: {
      findIncidentIssueLink,
      findIncident,
      findOpenIncidentCandidates,
      loadLinkedIncidentIssues,
      findProject,
      linkIssueToIncident,
      updateIssueGrouping,
    },
    lifecycle: incidentLifecycle,
    analyzeGrouping: analyzeIssueGrouping,
    logger,
  });
}
