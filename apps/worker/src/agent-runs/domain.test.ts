import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_STATES,
  type AgentRunState,
  DORMANT_STATES,
  IllegalAgentRunTransitionError,
  TERMINAL_STATES,
  assertAgentRunSourceState,
  isActiveState,
} from "./domain.js";

test("agent run state groups partition the domain states", () => {
  const all: AgentRunState[] = [...ACTIVE_STATES, ...DORMANT_STATES, ...TERMINAL_STATES];
  const expected: AgentRunState[] = [
    "queued",
    "repo_discovery",
    "running",
    "awaiting_human",
    "pr_retry_queued",
    "blocked_no_github",
    "complete",
    "failed",
  ];

  assert.deepEqual([...all].sort(), [...expected].sort());
  assert.equal(new Set(all).size, all.length);
});

test("isActiveState recognizes tickable states only", () => {
  for (const state of ACTIVE_STATES) assert.equal(isActiveState(state), true, state);
  for (const state of DORMANT_STATES) assert.equal(isActiveState(state), false, state);
  for (const state of TERMINAL_STATES) assert.equal(isActiveState(state), false, state);
  assert.equal(isActiveState("ready_to_pr"), false);
  assert.equal(isActiveState("unknown_state"), false);
});

test("assertAgentRunSourceState allows listed source states", () => {
  assert.doesNotThrow(() =>
    assertAgentRunSourceState("startRunning", "repo_discovery", ["repo_discovery"]),
  );
});

test("assertAgentRunSourceState throws a descriptive transition error", () => {
  assert.throws(
    () => assertAgentRunSourceState("startRunning", "queued", ["repo_discovery"]),
    (err) => {
      assert.ok(err instanceof IllegalAgentRunTransitionError);
      assert.equal(err.name, "IllegalTransitionError");
      assert.equal(
        err.message,
        'startRunning: cannot transition from "queued"; allowed source states: repo_discovery',
      );
      return true;
    },
  );
});
