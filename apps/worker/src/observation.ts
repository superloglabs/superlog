// Wiring for the observation sweep (see issues/observation-sweep.ts for the
// logic). Mirrors alerts.ts: the tick passes handleIssueTransition so the
// sweep escalates through the same incident-intake path as ingest.
import { db, schema } from "@superlog/db";
import { eq, sql } from "drizzle-orm";
import { runObservationSweep } from "./issues/observation-sweep.js";
import { logger } from "./logger.js";

export async function tickObservedIssues(
  handleIssueTransition: (issue: schema.Issue, transition: "escalated") => Promise<void>,
): Promise<number> {
  return runObservationSweep({
    async listUnderObservation(limit) {
      return db.query.issues.findMany({
        where: eq(schema.issues.status, "under_observation"),
        // NULLS FIRST: never-evaluated observations (fresh verdicts) must be
        // picked up before re-evaluations, or a backlog larger than the tick
        // limit would starve them forever (Postgres ASC puts NULLs last).
        orderBy: [sql`${schema.issues.observationLastEvaluatedAt} ASC NULLS FIRST`],
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
