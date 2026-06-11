import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentRunErrorLogMeta,
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
