import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WALL_CLOCK_MULTIPLIER,
  agentRunErrorLogMeta,
  awaitingEventsCompensationPresentation,
  awaitingEventsSlackMessage,
  awaitingHumanSecondsFromEvents,
  exceededWallClockBudget,
  isTransientError,
  publishAwaitingEventsUpdateIfCurrent,
} from "./status.js";

test("an open incident resumed during waiting publication compensates to running provider state", () => {
  assert.deepEqual(
    awaitingEventsCompensationPresentation({
      incidentStatus: "open",
      agentRunState: "running",
    }),
    {
      emoji: "arrow_forward",
      label: "Investigation resumed",
      summary: "Investigation resumed while the previous waiting update was publishing.",
    },
  );
});

test("resolution immediately after parking suppresses waiting provider updates", async () => {
  let published = 0;
  let reconciled = 0;

  const outcome = await publishAwaitingEventsUpdateIfCurrent({
    isCurrent: async () => false,
    publish: async () => {
      published += 1;
    },
    reconcileStalePublication: async () => {
      reconciled += 1;
    },
  });

  assert.equal(outcome, "skipped");
  assert.equal(published, 0);
  assert.equal(reconciled, 0);
});

test("resolution during waiting publication compensates the stale provider state", async () => {
  const ownership = [true, false];
  let published = 0;
  let reconciled = 0;

  const outcome = await publishAwaitingEventsUpdateIfCurrent({
    isCurrent: async () => ownership.shift() ?? false,
    publish: async () => {
      published += 1;
    },
    reconcileStalePublication: async () => {
      reconciled += 1;
    },
  });

  assert.equal(outcome, "reconciled");
  assert.equal(published, 1);
  assert.equal(reconciled, 1);
});

test("resume after the eligibility check replaces the waiting provider state", async () => {
  const ownership = [true, false];
  let providerLabel = "Waiting on PR review";

  const outcome = await publishAwaitingEventsUpdateIfCurrent({
    isCurrent: async () => ownership.shift() ?? false,
    publish: async () => {
      providerLabel = "Waiting on PR review";
    },
    reconcileStalePublication: async () => {
      providerLabel =
        awaitingEventsCompensationPresentation({
          incidentStatus: "open",
          agentRunState: "running",
        })?.label ?? providerLabel;
    },
  });

  assert.equal(outcome, "reconciled");
  assert.equal(providerLabel, "Investigation resumed");
});

test("awaiting PR review Slack copy includes PRs and the Linear ticket", () => {
  assert.equal(
    awaitingEventsSlackMessage(["https://github.com/acme/api/pull/10"], {
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42",
    }),
    ":hourglass_flowing_sand: Investigation is waiting on PR review. Open PRs: https://github.com/acme/api/pull/10 Linear ticket: ENG-42 (https://linear.app/acme/issue/ENG-42)",
  );
});

test("external-cause waiting copy names the source and next step without claiming resolution", () => {
  assert.equal(
    awaitingEventsSlackMessage([], null, {
      cause: "The provider account has no remaining credit.",
      source: "Recall.ai",
      evidence: "Bot creation returned HTTP 402 insufficient credit.",
      recommendedNextStep: "Top up the account before retrying bot creation.",
    }),
    ":warning: Investigation found an external cause in Recall.ai and remains open. The provider account has no remaining credit. Next step: Top up the account before retrying bot creation.",
  );
});

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

  assert.equal(exceededWallClockBudget({ startedAt, now: justUnder, maxRuntimeMinutes }), false);
  assert.equal(exceededWallClockBudget({ startedAt, now: justOver, maxRuntimeMinutes }), true);
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
  const startedAt = new Date("2026-07-09T00:35:00Z");
  const park = new Date("2026-07-09T00:37:00Z");
  const resume = new Date("2026-07-09T22:39:00Z"); // ~22h later
  const events = [
    { kind: "agent_run_started", createdAt: startedAt },
    { kind: "awaiting_human", createdAt: park },
    { kind: "resumed", createdAt: resume },
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents({ events, startedAt, now: new Date("2026-07-09T22:40:00Z") }),
    Math.round((resume.getTime() - park.getTime()) / 1_000),
  );
});

test("awaitingHumanSecondsFromEvents adds multiple park cycles", () => {
  const startedAt = new Date("2026-07-08T23:59:00Z");
  const events = [
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T00:00:00Z") },
    { kind: "resumed", createdAt: new Date("2026-07-09T01:00:00Z") }, // 1h
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T02:00:00Z") },
    { kind: "resumed", createdAt: new Date("2026-07-09T02:30:00Z") }, // 30m
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents({ events, startedAt, now: new Date("2026-07-09T03:00:00Z") }),
    90 * 60,
  );
});

test("awaitingHumanSecondsFromEvents excludes parks before startedAt (repo-discovery)", () => {
  // A repo_discovery pause emits `awaiting_human` before the managed session
  // starts, and the pre-session resume path requeues WITHOUT a `resumed`
  // event. That dangling, pre-startedAt park must not be subtracted — doing so
  // would silently disable the wall-clock backstop once the run starts.
  const startedAt = new Date("2026-07-09T02:00:00Z");
  const events = [
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T00:00:00Z") }, // pre-session, no resumed
    { kind: "agent_run_started", createdAt: startedAt },
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents({ events, startedAt, now: new Date("2026-07-09T09:00:00Z") }),
    0,
  );
});

test("awaitingHumanSecondsFromEvents clamps a park that straddles startedAt", () => {
  // Park opens before startedAt but the matching resume lands after it — only
  // the portion inside [startedAt, now] counts.
  const startedAt = new Date("2026-07-09T01:00:00Z");
  const events = [
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T00:00:00Z") },
    { kind: "resumed", createdAt: new Date("2026-07-09T01:30:00Z") }, // 30m after startedAt
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents({ events, startedAt, now: new Date("2026-07-09T02:00:00Z") }),
    30 * 60,
  );
});

test("awaitingHumanSecondsFromEvents does not count a dangling open park", () => {
  // No matching `resumed` → the park's end is untracked; it must not extend to
  // `now`. In the sync path the run is already `running`, so an unclosed
  // `awaiting_human` here is a spent repo-discovery pause, not an active wait.
  const startedAt = new Date("2026-07-09T00:00:00Z");
  const events = [{ kind: "awaiting_human", createdAt: new Date("2026-07-09T00:10:00Z") }];

  assert.equal(
    awaitingHumanSecondsFromEvents({ events, startedAt, now: new Date("2026-07-09T05:00:00Z") }),
    0,
  );
});

test("awaitingHumanSecondsFromEvents is 0 when the run never parked", () => {
  const startedAt = new Date("2026-07-09T00:00:00Z");
  const events = [
    { kind: "agent_run_started", createdAt: startedAt },
    { kind: "report_findings", createdAt: new Date("2026-07-09T00:02:00Z") },
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents({ events, startedAt, now: new Date("2026-07-09T00:03:00Z") }),
    0,
  );
});

test("awaitingHumanSecondsFromEvents is 0 with no startedAt", () => {
  const events = [
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T00:00:00Z") },
    { kind: "resumed", createdAt: new Date("2026-07-09T01:00:00Z") },
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents({
      events,
      startedAt: null,
      now: new Date("2026-07-09T02:00:00Z"),
    }),
    0,
  );
});

test("awaitingHumanSecondsFromEvents tolerates unordered events", () => {
  const startedAt = new Date("2026-07-08T23:59:00Z");
  const events = [
    { kind: "resumed", createdAt: new Date("2026-07-09T01:00:00Z") },
    { kind: "awaiting_human", createdAt: new Date("2026-07-09T00:00:00Z") },
  ];

  assert.equal(
    awaitingHumanSecondsFromEvents({ events, startedAt, now: new Date("2026-07-09T02:00:00Z") }),
    60 * 60,
  );
});

test("exceededWallClockBudget is independent of provider-reported activeSeconds", () => {
  // Reproduces the bug we hit in prod: Anthropic returns active_seconds: null
  // for idle sessions, so the provider-side budget never trips. Wall-clock
  // must catch these regardless of what the provider reports.
  const startedAt = new Date("2026-05-01T00:00:00Z");
  const now = new Date("2026-05-28T00:00:00Z"); // 27 days later

  assert.equal(exceededWallClockBudget({ startedAt, now, maxRuntimeMinutes: 90 }), true);
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
