import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIXED_IN_CURRENT_CODE_COOLDOWN_MS,
  isAutoAgentRunSuppressed,
} from "./incident-cooldown.js";

const NOW = new Date("2026-05-07T12:00:00.000Z");

test("incidents with no cooldown set are never suppressed", () => {
  assert.equal(isAutoAgentRunSuppressed({ autoInvestigateSuppressedUntil: null }, NOW), false);
});

test("incidents whose cooldown is in the future are suppressed", () => {
  const future = new Date(NOW.getTime() + 60 * 1000);
  assert.equal(
    isAutoAgentRunSuppressed({ autoInvestigateSuppressedUntil: future }, NOW),
    true,
  );
});

test("incidents whose cooldown has already elapsed are not suppressed", () => {
  const past = new Date(NOW.getTime() - 1);
  assert.equal(isAutoAgentRunSuppressed({ autoInvestigateSuppressedUntil: past }, NOW), false);
});

test("the cooldown window is 24 hours", () => {
  // Locked in here because changing this knob silently changes how loudly
  // Slack reports recurrences during the deploy gap. If you really need a
  // different window, change it deliberately and update this test.
  assert.equal(FIXED_IN_CURRENT_CODE_COOLDOWN_MS, 24 * 60 * 60 * 1000);
});

test("a cooldown exactly at `now` is treated as elapsed (strict-greater comparison)", () => {
  // Edge case: if the timer fires at exactly the window boundary, we want the
  // next regression to investigate, not skip. Using strict `>` instead of `>=`
  // guarantees we don't drop a real signal because the clock landed on the
  // same millisecond.
  assert.equal(
    isAutoAgentRunSuppressed({ autoInvestigateSuppressedUntil: NOW }, NOW),
    false,
  );
});
