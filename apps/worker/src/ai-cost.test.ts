import assert from "node:assert/strict";
import { test } from "node:test";
import { type TokenUsage, estimateCostUsd, sessionRuntimeUsd } from "./ai-cost.js";

const ONE_M: TokenUsage = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

test("Sonnet 4.6 token pricing ($3 / $15 / $0.30 / $3.75 per Mtok)", () => {
  assert.equal(estimateCostUsd("claude-sonnet-4-6", { ...ONE_M }), 3);
  assert.equal(estimateCostUsd("claude-sonnet-4-6", { ...ONE_M, inputTokens: 0, outputTokens: 1_000_000 }), 15);
  assert.equal(estimateCostUsd("claude-sonnet-4-6", { ...ONE_M, inputTokens: 0, cacheReadTokens: 1_000_000 }), 0.3);
  assert.equal(
    estimateCostUsd("claude-sonnet-4-6", { ...ONE_M, inputTokens: 0, cacheCreationTokens: 1_000_000 }),
    3.75,
  );
});

test("Opus 4.7 token pricing corrected to $5 / $25 / $0.50 / $6.25 (was $15/$75)", () => {
  assert.equal(estimateCostUsd("claude-opus-4-7", { ...ONE_M }), 5);
  assert.equal(estimateCostUsd("claude-opus-4-7", { ...ONE_M, inputTokens: 0, outputTokens: 1_000_000 }), 25);
  assert.equal(estimateCostUsd("claude-opus-4-7", { ...ONE_M, inputTokens: 0, cacheReadTokens: 1_000_000 }), 0.5);
  assert.equal(
    estimateCostUsd("claude-opus-4-7", { ...ONE_M, inputTokens: 0, cacheCreationTokens: 1_000_000 }),
    6.25,
  );
});

test("legacy Opus (<=4.6) bills at $15/$75, while Opus 4.7+ stays at $5/$25", () => {
  // Opus 4.1 / 4.0 / claude-3-opus predate the 4.7 price cut → $15 in / $75 out.
  assert.equal(estimateCostUsd("claude-opus-4-1", { ...ONE_M }), 15);
  assert.equal(estimateCostUsd("claude-opus-4-1", { ...ONE_M, inputTokens: 0, outputTokens: 1_000_000 }), 75);
  assert.equal(estimateCostUsd("claude-3-opus-20240229", { ...ONE_M }), 15);
  // 4.7 and 4.8 stay on the new $5/$25.
  assert.equal(estimateCostUsd("claude-opus-4-8", { ...ONE_M }), 5);
});

test("unknown model falls back to Sonnet pricing", () => {
  assert.equal(estimateCostUsd("some-other-model", { ...ONE_M }), 3);
});

test("session runtime billed at $0.08 per session-hour", () => {
  assert.equal(sessionRuntimeUsd(3600), 0.08);
  assert.equal(sessionRuntimeUsd(0), 0);
  assert.equal(sessionRuntimeUsd(-5), 0);
  // ~7 min median run → tiny
  assert.ok(Math.abs(sessionRuntimeUsd(420) - 0.009333) < 1e-5);
});
