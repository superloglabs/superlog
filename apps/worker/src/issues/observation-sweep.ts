// Observation sweep: evaluate escalation triggers for issues that a noise
// verdict placed `under_observation`. Suppressed occurrences keep bumping
// issues.event_count at ingest, so both trigger kinds evaluate from Postgres
// counters alone:
//   count — total growth since the observation baseline.
//   rate  — per-minute average of the event_count delta since the previous
//           sweep evaluation, checked only once a full rate window elapsed.
// A fired trigger escalates through the same intake path as a resolved-issue
// recurrence: new incident chained to the predecessor, issue back to `open`.
import { OBSERVATION_RATE_WINDOW_MINUTES, escalationTriggerFired, type schema } from "@superlog/db";

export type ObservationSweepLogger = {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
};

export type ObservationSweepDeps = {
  listUnderObservation(limit: number): Promise<schema.Issue[]>;
  // Persist observation_last_evaluated_at / observation_last_event_count.
  recordEvaluation(issueId: string, at: Date, eventCount: number): Promise<void>;
  // Route the fired issue through incident intake (transition "escalated").
  escalate(issue: schema.Issue): Promise<void>;
  logger: ObservationSweepLogger;
  now?: () => Date;
  limit?: number;
};

export async function runObservationSweep(deps: ObservationSweepDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const issues = await deps.listUnderObservation(deps.limit ?? 200);
  let escalated = 0;
  for (const issue of issues) {
    // Per-issue isolation: one poisoned row must not wedge the whole sweep.
    try {
      const trigger = issue.escalationTrigger;
      if (!trigger) {
        deps.logger.warn(
          { scope: "observation_sweep", issue_id: issue.id },
          "issue under observation has no escalation trigger; skipping",
        );
        continue;
      }

      if (trigger.kind === "rate" && issue.observationLastEvaluatedAt == null) {
        // First pass after observation began: anchor the window.
        await deps.recordEvaluation(issue.id, now, issue.eventCount);
        continue;
      }

      const lastEvaluatedAt = issue.observationLastEvaluatedAt ?? issue.observationStartedAt ?? now;
      const minutesSinceLastEvaluation = (now.getTime() - lastEvaluatedAt.getTime()) / 60_000;
      const eventsSinceLastEvaluation =
        issue.eventCount - (issue.observationLastEventCount ?? issue.eventCount);

      const fired = escalationTriggerFired({
        trigger,
        currentEventCount: issue.eventCount,
        baselineEventCount: issue.observationBaselineEventCount ?? 0,
        eventsSinceLastEvaluation,
        minutesSinceLastEvaluation,
      });

      if (fired) {
        deps.logger.info(
          {
            scope: "observation_sweep",
            issue_id: issue.id,
            project_id: issue.projectId,
            trigger,
            event_count: issue.eventCount,
            events_since_last_evaluation: eventsSinceLastEvaluation,
            minutes_since_last_evaluation: minutesSinceLastEvaluation,
          },
          "escalation trigger fired",
        );
        await deps.escalate(issue);
        escalated += 1;
        continue;
      }

      // Slide the rate window forward once a full window has passed without
      // firing, so the next evaluation measures a fresh interval.
      if (
        trigger.kind === "rate" &&
        minutesSinceLastEvaluation >= OBSERVATION_RATE_WINDOW_MINUTES
      ) {
        await deps.recordEvaluation(issue.id, now, issue.eventCount);
      }
    } catch (err) {
      deps.logger.error(
        {
          scope: "observation_sweep",
          issue_id: issue.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "observation sweep failed for issue",
      );
    }
  }
  return escalated;
}
