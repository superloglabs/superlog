import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildQueueHealthObservations,
  pgbossSchemaName,
  recordTickHeartbeat,
  tickHeartbeatAgeMs,
  withQueueRecoveryZeros,
} from "./queue-health.js";

const NOW = new Date("2026-07-13T18:00:00.000Z");

test("per-queue gauges carry the queue name and oldest pending age", () => {
  const observations = buildQueueHealthObservations(
    [
      {
        queue: "agent-run-advance",
        pending: 12,
        active: 10,
        oldestPendingAt: new Date("2026-07-13T17:58:00.000Z"),
      },
      { queue: "issue-transition", pending: 0, active: 0, oldestPendingAt: null },
    ],
    NOW,
  );

  const advance = observations.filter((o) => o.attributes?.["queue.name"] === "agent-run-advance");
  assert.deepEqual(
    advance.map((o) => [o.metric, o.value]),
    [
      ["superlog.worker.jobs.pending", 12],
      ["superlog.worker.jobs.active", 10],
      ["superlog.worker.jobs.oldest_pending_age_ms", 120_000],
    ],
  );
  const transition = observations.filter(
    (o) => o.attributes?.["queue.name"] === "issue-transition",
  );
  // No pending jobs → age reports 0, not a stale/frozen value.
  assert.deepEqual(
    transition.map((o) => [o.metric, o.value]),
    [
      ["superlog.worker.jobs.pending", 0],
      ["superlog.worker.jobs.active", 0],
      ["superlog.worker.jobs.oldest_pending_age_ms", 0],
    ],
  );
});

test("an empty snapshot still emits explicit zeros so series don't freeze", () => {
  const observations = buildQueueHealthObservations([], NOW);
  assert.deepEqual(
    observations.map((o) => [o.metric, o.value, o.attributes?.["queue.name"]]),
    [
      ["superlog.worker.jobs.pending", 0, "none"],
      ["superlog.worker.jobs.active", 0, "none"],
      ["superlog.worker.jobs.oldest_pending_age_ms", 0, "none"],
    ],
  );
});

test("a queue that drains out of the snapshot gets one recovery zero, then drops", () => {
  const drained = withQueueRecoveryZeros([], new Set(["agent-run-advance"]));
  assert.deepEqual(drained, [
    { queue: "agent-run-advance", pending: 0, active: 0, oldestPendingAt: null },
  ]);

  // The recovery zero must not keep itself alive: with the previous snapshot
  // also empty, nothing is emitted for the queue on the following pass.
  assert.deepEqual(withQueueRecoveryZeros([], new Set()), []);

  // A queue still present in the snapshot is not duplicated.
  const live = [{ queue: "agent-run-advance", pending: 3, active: 1, oldestPendingAt: null }];
  assert.deepEqual(withQueueRecoveryZeros(live, new Set(["agent-run-advance"])), live);
});

test("tick heartbeat age measures time since the last recorded tick", () => {
  recordTickHeartbeat(new Date("2026-07-13T17:59:30.000Z"));
  assert.equal(tickHeartbeatAgeMs(NOW), 30_000);
});

test("pgboss schema name rejects unsafe identifiers", () => {
  assert.equal(pgbossSchemaName(undefined), "pgboss");
  assert.equal(pgbossSchemaName("pgboss_test"), "pgboss_test");
  assert.equal(pgbossSchemaName("bad; DROP TABLE x"), "pgboss");
  assert.equal(pgbossSchemaName("1leading"), "pgboss");
});
