import type { handleIssueTransition } from "../incidents/workflow.js";
import { createSentryIssueIngestor } from "./ingest.js";
import { createDrizzleSentryIssueIngestRepository } from "./repository.js";

export function tickSentryIssueEvents(
  onIssueTransition: typeof handleIssueTransition,
): Promise<number> {
  return createSentryIssueIngestor({
    repository: createDrizzleSentryIssueIngestRepository(),
    handleIssueTransition: onIssueTransition,
  }).tick();
}
