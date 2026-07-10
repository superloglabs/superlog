import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentRunErrorLogMeta,
  awaitingHumanSecondsFromEvents,
  exceededWallClockBudget,
  isTransientError,
  WALL_CLOCK_MULTIPLIER,
} from "./status.js";

test("isTransientError handles cyclic cause chains", () => {
  const err = { code: "NOPE" } as { code: string; cause?: unknown };
  err.cause = err;

  assert.equal(isTransientError(err), false);
});

test("isTransientError finds transient nested causes", () => {
  const err = { cause: { code: "ECONNRESET" } };

  assert.equal(isTransientError(err), true);
});

test("agentRunErrorLogMeta preserves bounded error messages", () => {
  const err = Object.assign(new Error("Failed to validate or open the PR."), {
    code: "ERR_PR_OPEN",
  });

  assert.deepEqual(agentRunErrorLogMeta(err), {
    name: "Error",
    code: "ERR_PR_OPEN",
    message: "Failed to validate or open the PR.",
  });
});

test("agentRunErrorLogMeta redacts noisy long messages", () => {
  const err = new Error(`${"x".repeat(600)}secret_tail`);

  const meta = agentRunErrorLogMeta(err);

  assert.equal(meta?.name, "Error");
  assert.equal(meta?.message?.length, 500);
  assert.equal(meta?.message?.endsWith("secret_tail"), false);
});

test("exceededWallClockBudget treats null startedAt as 'not started, not expired'", () => {
  assert.equal(
    exceededWallClockBudget({
      startedAt: null,
      now: new Date(),
      maxRuntimeMinutes: 90,
    }),
    false,
  );
});

test("exceededWallClockBudget fires when wall-clock age exceeds maxRuntimeMinutes * multiplier", () => {
  const startedAt = new Date("2026-05-27T00:00:00Z");
  const maxRuntimeMinutes = 90;
  const justOver = new Date(
    startedAt.getTime() + WALL_CLOCK_MULTIPLIER * maxRuntimeMinutes * 60_000 + 1_000,
  );
  const justUnder = new Date(
    startedAt.getTime() + WALL_CLOCK_MULTIPLIER * maxRuntimeMinutes * 60_000 - 1_000,
  );

  assert.equal(
    exceededWallClockBudget({ startedAt, now: justUnder, maxRuntimeMinutes }),
    false,
  );
  assert.equal(
    exceededWallClockBudget({ startedAt, now: justOver, maxRuntimeMinutes }),
    true,
  );
});

test("exceededWallClockBudget excludes time parked awaiting a human", () => {
  // The prod case: agent diagnosed in ~2 min, called ask_human, parked for
  // ~22h, then the human replied and it resumed. Without excluding the parked
  // time the resumed run is instantly reaped even though it barely ran.
  const startedAt = new Date("2026-07-09T00:00:00Z");
  const maxRuntimeMinutes = 90;
  const budgetMs = WALL_CLOCK_MULTIPLIER * maxRuntimeMinutes * 60_000; // 6h
  // 22h later, but 21h 58m of it was spent parked awaiting the human.
  const now = new Date(startedAt.getTime() + 22 * 60 * 60_000);
  const awaitingHumanSeconds = 21 * 60 * 60 + 58 * 60; // active time ≈ 2 min

  assert.equal(
    exceededWallClockBudget({ startedAt, now, maxRuntimeMinutes, awaitingHumanSeconds }),
    false,
  );

  // Same wall-clock age with no parking → over the 6h budget, still fires.
  assert.equal(
    exceededWallClockBudget({
      startedAt,
      now: new Date(startedAt.getTime() + budgetMs + 1_000),
      maxRuntimeMinutes,
      awaitingHumanSeconds: 0,
    }),
    true,
  );

  // Parked time that still leaves active time over budget → fires.
  assert.equal(
    exceededWallClockBudget({
      startedAt,
      now: new Date(startedAt.getTime() + budgetMs + 60 * 60_000), // 7h wall clock
      maxRuntimeMinutes,
      awaitingHumanSeconds: 30 * 60, // only 30 min parked → 6.5h active > 6h
    }),
    true,
  );
});

test("awaitingHumanSecondsFromEvents sums a single park→resume gap", () => {
  const park = new Date("2026-07-09T00:37:00Z");
  const resume = new Date("2026-07-09T22:39:00Z"); // ~22h later
  const events = [
    { kind: "started", createdAt: new Date("2026-07-09T00:35:00Z") },
    { kind: "awaiting_human", createdAt: park },
    { kind: "resumed", createdAt: resume },
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents(events, new Date("2026-07-09T22:40:00Z")),
    Math.round((resume.getTime() - park.getTime()) / 1_000),
  );
});

test("awaitingHumanSecondsFromEvents adds multiple park cycles", () => {
  const events = [
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T00:00:00Z") },
    { kind: "resumed", createdAt: new Date("2026-07-09T01:00:00Z") }, // 1h
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T02:00:00Z") },
    { kind: "resumed", createdAt: new Date("2026-07-09T02:30:00Z") }, // 30m
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents(events, new Date("2026-07-09T03:00:00Z")),
    90 * 60,
  );
});

test("awaitingHumanSecondsFromEvents counts a still-parked run up to now", () => {
  const park = new Date("2026-07-09T00:00:00Z");
  const now = new Date("2026-07-09T05:00:00Z"); // still parked, 5h
  const events = [{ kind: "awaiting_human", createdAt: park }];

  assert.equal(awaitingHumanSecondsFromEvents(events, now), 5 * 60 * 60);
});

test("awaitingHumanSecondsFromEvents is 0 when the run never parked", () => {
  const events = [
    { kind: "started", createdAt: new Date("2026-07-09T00:00:00Z") },
    { kind: "report_findings", createdAt: new Date("2026-07-09T00:02:00Z") },
  ];

  assert.equal(awaitingHumanSecondsFromEvents(events, new Date("2026-07-09T00:03:00Z")), 0);
});

test("awaitingHumanSecondsFromEvents tolerates unordered events", () => {
  const events = [
    { kind: "resumed", createdAt: new Date("2026-07-09T01:00:00Z") },
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T00:00:00Z") },
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents(events, new Date("2026-07-09T02:00:00Z")),
    60 * 60,
  );
});

test("exceededWallClockBudget is independent of provider-reported activeSeconds", () => {
  // Reproduces the bug we hit in prod: Anthropic returns active_seconds: null
  // for idle sessions, so the provider-side budget never trips. Wall-clock
  // must catch these regardless of what the provider reports.
  const startedAt = new Date("2026-05-01T00:00:00Z");
  const now = new Date("2026-05-28T00:00:00Z"); // 27 days later

  assert.equal(
    exceededWallClockBudget({ startedAt, now, maxRuntimeMinutes: 90 }),
    true,
  );
});

test("failure log messages split log fingerprints per failure reason", async () => {
  const { fingerprintLog, messageBucketFor } = await import("@superlog/fingerprint");
  const { agentRunFailureLogMessage } = await import("./status.js");

  const validation = agentRunFailureLogMessage("patch_validation_failed");
  const sync = agentRunFailureLogMessage("sync_failed");

  // Human-readable, no >=20-char tokens that messageBucketFor would collapse
  // into <id> (the raw enum `patch_validation_failed` is 23 chars and would).
  assert.equal(validation, "agent run failed: patch validation failed");
  assert.equal(sync, "agent run failed: sync failed");

  // Different reasons must land in different issues AND different buckets —
  // a single shared fingerprint is how the June pileup hid inside a
  // three-week-old open incident.
  const fp = (body: string) =>
    fingerprintLog({ body, severity: "ERROR", service: "superlog-worker" }).hash;
  assert.notEqual(fp(validation), fp(sync));
  assert.notEqual(messageBucketFor(validation), messageBucketFor(sync));
});
