import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLLOW_UP_MAX_AGE_DAYS,
  MAX_FOLLOW_UP_RUNS,
  decideInboundContinuation,
  evaluateFollowUpEligibility,
} from "./agent-follow-up.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const RECENT = new Date("2026-06-09T12:00:00Z");
const STALE = new Date(NOW.getTime() - (FOLLOW_UP_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000);

function input(overrides: Partial<Parameters<typeof evaluateFollowUpEligibility>[0]> = {}) {
  return {
    agentRunEnabled: true,
    autoFollowUpEnabled: true,
    confirmed: false,
    priorRun: { state: "complete", completedAt: RECENT },
    followUpCount: 0,
    activeRun: null,
    now: NOW,
    ...overrides,
  };
}

test("eligible interaction on a recently completed run enqueues", () => {
  assert.deepEqual(evaluateFollowUpEligibility(input()), { action: "enqueue" });
});

test("failed prior runs are also revivable", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ priorRun: { state: "failed", completedAt: RECENT } }),
  );
  assert.deepEqual(verdict, { action: "enqueue" });
});

test("skips when agent runs are disabled for the project", () => {
  const verdict = evaluateFollowUpEligibility(input({ agentRunEnabled: false }));
  assert.deepEqual(verdict, { action: "skip", reason: "agent_runs_disabled" });
});

test("skips when auto follow-up is disabled and the request is not confirmed", () => {
  const verdict = evaluateFollowUpEligibility(input({ autoFollowUpEnabled: false }));
  assert.deepEqual(verdict, { action: "skip", reason: "auto_follow_up_disabled" });
});

test("a confirmed request bypasses the auto-follow-up gate but not the rest", () => {
  assert.deepEqual(
    evaluateFollowUpEligibility(input({ autoFollowUpEnabled: false, confirmed: true })),
    { action: "enqueue" },
  );
  assert.deepEqual(
    evaluateFollowUpEligibility(
      input({ autoFollowUpEnabled: false, confirmed: true, followUpCount: MAX_FOLLOW_UP_RUNS }),
    ),
    { action: "skip", reason: "follow_up_cap_reached" },
  );
});

test("skips when there is no terminal prior run", () => {
  assert.deepEqual(evaluateFollowUpEligibility(input({ priorRun: null })), {
    action: "skip",
    reason: "no_prior_run",
  });
  assert.deepEqual(
    evaluateFollowUpEligibility(input({ priorRun: { state: "running", completedAt: null } })),
    { action: "skip", reason: "no_prior_run" },
  );
});

test("skips interactions older than the staleness window", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ priorRun: { state: "complete", completedAt: STALE } }),
  );
  assert.deepEqual(verdict, { action: "skip", reason: "prior_run_too_old" });
});

test("skips once the per-incident follow-up cap is reached", () => {
  const verdict = evaluateFollowUpEligibility(input({ followUpCount: MAX_FOLLOW_UP_RUNS }));
  assert.deepEqual(verdict, { action: "skip", reason: "follow_up_cap_reached" });
});

test("append wins over the cap so review-burst interactions are not dropped", () => {
  const verdict = evaluateFollowUpEligibility(
    input({
      followUpCount: MAX_FOLLOW_UP_RUNS,
      activeRun: { id: "run-2", state: "queued", trigger: "pr_comment" },
    }),
  );
  assert.deepEqual(verdict, { action: "append", runId: "run-2" });
});

test("appends to a still-queued follow-up run instead of enqueuing a second", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ activeRun: { id: "run-2", state: "queued", trigger: "pr_comment" } }),
  );
  assert.deepEqual(verdict, { action: "append", runId: "run-2" });
});

test("skips while a run is actively executing", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ activeRun: { id: "run-2", state: "running", trigger: "pr_comment" } }),
  );
  assert.deepEqual(verdict, { action: "skip", reason: "run_active" });
});

test("skips when the active run is the original (non-follow-up) investigation", () => {
  const verdict = evaluateFollowUpEligibility(
    input({ activeRun: { id: "run-1", state: "queued", trigger: "incident" } }),
  );
  assert.deepEqual(verdict, { action: "skip", reason: "run_active" });
});

test("treats a queued manual investigation as initial — skips, does not append", () => {
  // A user-started ("manual") run is an initial investigation like "incident":
  // an inbound interaction while it's queued must not stack onto it.
  const verdict = evaluateFollowUpEligibility(
    input({ activeRun: { id: "run-1", state: "queued", trigger: "manual" } }),
  );
  assert.deepEqual(verdict, { action: "skip", reason: "run_active" });
});

// --- Session-continuity routing (decideInboundContinuation) ---
//
// The new model: an inbound message continues the SAME durable provider
// session rather than spinning up a fresh investigation. These tests pin the
// routing decision; the worker handles the actual resume/steer/fall-back.

function continuation(overrides: Partial<Parameters<typeof decideInboundContinuation>[0]> = {}) {
  return {
    agentRunEnabled: true,
    autoFollowUpEnabled: true,
    confirmed: false,
    latestRun: { id: "run-1", state: "complete", providerSessionId: "sess_1" },
    ...overrides,
  };
}

test("a completed run with a live session resumes that session (no new investigation)", () => {
  assert.deepEqual(decideInboundContinuation(continuation()), {
    action: "resume",
    runId: "run-1",
  });
});

test("a failed run with a session is still resumable", () => {
  assert.deepEqual(
    decideInboundContinuation(
      continuation({ latestRun: { id: "run-2", state: "failed", providerSessionId: "sess_2" } }),
    ),
    { action: "resume", runId: "run-2" },
  );
});

test("a terminal run without a session falls back to a cold-start run", () => {
  assert.deepEqual(
    decideInboundContinuation(
      continuation({ latestRun: { id: "run-3", state: "complete", providerSessionId: null } }),
    ),
    { action: "cold_start" },
  );
});

test("a message arriving mid-turn steers the running session instead of stacking a run", () => {
  for (const state of ["running", "repo_discovery"]) {
    assert.deepEqual(
      decideInboundContinuation(
        continuation({ latestRun: { id: "run-4", state, providerSessionId: "sess_4" } }),
      ),
      { action: "steer", runId: "run-4" },
      `state=${state}`,
    );
  }
});

test("an awaiting-human run always delivers (worker resumes, or requeues if no session yet)", () => {
  assert.deepEqual(
    decideInboundContinuation(
      continuation({ latestRun: { id: "run-5", state: "awaiting_human", providerSessionId: "s" } }),
    ),
    { action: "resume", runId: "run-5" },
  );
  assert.deepEqual(
    decideInboundContinuation(
      continuation({
        latestRun: { id: "run-5", state: "awaiting_human", providerSessionId: null },
      }),
    ),
    { action: "resume", runId: "run-5" },
  );
});

test("no prior run at all has nothing to continue", () => {
  assert.deepEqual(decideInboundContinuation(continuation({ latestRun: null })), {
    action: "skip",
    reason: "no_prior_run",
  });
});

test("project gates still apply: agent runs disabled, auto-follow-up off (unless confirmed)", () => {
  assert.deepEqual(decideInboundContinuation(continuation({ agentRunEnabled: false })), {
    action: "skip",
    reason: "agent_runs_disabled",
  });
  assert.deepEqual(decideInboundContinuation(continuation({ autoFollowUpEnabled: false })), {
    action: "skip",
    reason: "auto_follow_up_disabled",
  });
  // An explicit human confirmation (e.g. the feedback button) bypasses the
  // auto-follow-up gate and still resumes.
  assert.deepEqual(
    decideInboundContinuation(continuation({ autoFollowUpEnabled: false, confirmed: true })),
    { action: "resume", runId: "run-1" },
  );
});
