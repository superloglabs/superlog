import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideOccurrenceAction,
  escalationTriggerFired,
  parseEscalationTrigger,
} from "./issue-state.js";

test("decideOccurrenceAction maps each status to the pipeline action", () => {
  assert.deepEqual(decideOccurrenceAction("open"), { kind: "investigate" });
  assert.deepEqual(decideOccurrenceAction("silenced"), { kind: "suppress", status: "silenced" });
  assert.deepEqual(decideOccurrenceAction("under_observation"), {
    kind: "suppress",
    status: "under_observation",
  });
  assert.deepEqual(decideOccurrenceAction("resolved"), { kind: "recur" });
  // Unknown / legacy values must fall back to the normal path, not crash ingest.
  assert.deepEqual(decideOccurrenceAction("bogus"), { kind: "investigate" });
});

test("parseEscalationTrigger accepts valid shapes and rejects garbage", () => {
  assert.deepEqual(parseEscalationTrigger({ kind: "rate", perMinute: 3 }), {
    kind: "rate",
    perMinute: 3,
  });
  assert.deepEqual(parseEscalationTrigger({ kind: "count", count: 100 }), {
    kind: "count",
    count: 100,
  });
  assert.equal(parseEscalationTrigger({ kind: "rate", perMinute: 0 }), null);
  assert.equal(parseEscalationTrigger({ kind: "rate", perMinute: -1 }), null);
  assert.equal(parseEscalationTrigger({ kind: "count", count: 2.5 }), null);
  assert.equal(parseEscalationTrigger({ kind: "count" }), null);
  assert.equal(parseEscalationTrigger({ kind: "sometimes" }), null);
  assert.equal(parseEscalationTrigger(null), null);
  assert.equal(parseEscalationTrigger("rate"), null);
});

test("count trigger fires on growth since the observation baseline", () => {
  const base = {
    trigger: { kind: "count", count: 50 } as const,
    baselineEventCount: 100,
    eventsSinceLastEvaluation: 0,
    minutesSinceLastEvaluation: 1,
  };
  assert.equal(escalationTriggerFired({ ...base, currentEventCount: 149 }), false);
  assert.equal(escalationTriggerFired({ ...base, currentEventCount: 150 }), true);
});

test("rate trigger fires on the per-minute average since the last evaluation", () => {
  const base = {
    trigger: { kind: "rate", perMinute: 4 } as const,
    baselineEventCount: 0,
    currentEventCount: 10_000,
  };
  // Below the window: never fires, regardless of burst size.
  assert.equal(
    escalationTriggerFired({
      ...base,
      eventsSinceLastEvaluation: 500,
      minutesSinceLastEvaluation: 2,
    }),
    false,
  );
  assert.equal(
    escalationTriggerFired({
      ...base,
      eventsSinceLastEvaluation: 19,
      minutesSinceLastEvaluation: 5,
    }),
    false,
  );
  assert.equal(
    escalationTriggerFired({
      ...base,
      eventsSinceLastEvaluation: 20,
      minutesSinceLastEvaluation: 5,
    }),
    true,
  );
  // Longer gaps (worker downtime) average over the elapsed time.
  assert.equal(
    escalationTriggerFired({
      ...base,
      eventsSinceLastEvaluation: 39,
      minutesSinceLastEvaluation: 10,
    }),
    false,
  );
  assert.equal(
    escalationTriggerFired({
      ...base,
      eventsSinceLastEvaluation: 40,
      minutesSinceLastEvaluation: 10,
    }),
    true,
  );
});
