// Wiring for the observation sweep (see issues/observation-sweep.ts for the
// logic). Mirrors alerts.ts: the tick passes handleIssueTransition so the
// sweep escalates through the same incident-intake path as ingest.
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { runObservationSweep } from "./issues/observation-sweep.js";
import { logger } from "./logger.js";

export async function tickObservedIssues(
  handleIssueTransition: (issue: schema.Issue, transition: "escalated") => Promise<void>,
): Promise<number> {
  return runObservationSweep({
    async listUnderObservation(limit) {
      return db.query.issues.findMany({
        where: eq(schema.issues.status, "under_observation"),
        orderBy: (issues, { asc }) => [asc(issues.observationLastEvaluatedAt)],
        limit,
      });
    },
    async recordEvaluation(issueId, at, eventCount) {
      await db
        .update(schema.issues)
        .set({ observationLastEvaluatedAt: at, observationLastEventCount: eventCount })
        .where(eq(schema.issues.id, issueId));
    },
    escalate: (issue) => handleIssueTransition(issue, "escalated"),
    logger,
  });
}
