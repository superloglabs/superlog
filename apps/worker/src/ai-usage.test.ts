import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentRunOutcome,
  type AiUsageSink,
  type RecordAgentRunCompletionInput,
  type RecordTokenUsageInput,
  initAiUsageSink,
  isProjectSpendCapExceeded,
  recordAgentRunCompletion,
  recordTokenUsage,
  resetAiUsageSink,
  setAiUsageSink,
  sumUsage,
} from "./ai-usage.js";

const originalSinkModule = process.env.AI_USAGE_SINK_MODULE;

test.afterEach(() => {
  resetAiUsageSink();
  if (originalSinkModule === undefined) {
    Reflect.deleteProperty(process.env, "AI_USAGE_SINK_MODULE");
  } else {
    process.env.AI_USAGE_SINK_MODULE = originalSinkModule;
  }
});

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 };

function recordingSink(): {
  sink: AiUsageSink;
  tokenCalls: RecordTokenUsageInput[];
  runCalls: RecordAgentRunCompletionInput[];
} {
  const tokenCalls: RecordTokenUsageInput[] = [];
  const runCalls: RecordAgentRunCompletionInput[] = [];
  return {
    tokenCalls,
    runCalls,
    sink: {
      recordTokenUsage(i) {
        tokenCalls.push(i);
      },
      recordAgentRunCompletion(i) {
        runCalls.push(i);
      },
    },
  };
}

test("default sink is a no-op and the forwarders never throw", async () => {
  await recordTokenUsage({ orgId: "o", model: "claude-sonnet-4-6", callSite: "digest", usage });
  await recordAgentRunCompletion({
    orgId: "o",
    model: "claude-sonnet-4-6",
    callSite: "agent_run",
    usage,
    activeSeconds: 1,
    outcome: "complete_with_pr",
    hasPr: true,
  });
});

test("setAiUsageSink installs a sink the forwarders delegate to", async () => {
  const { sink, tokenCalls, runCalls } = recordingSink();
  setAiUsageSink(sink);

  await recordTokenUsage({ orgId: "o", model: "m", callSite: "grouping", usage });
  const outcome: AgentRunOutcome = "awaiting_human";
  await recordAgentRunCompletion({
    orgId: "o",
    model: "m",
    callSite: "agent_run",
    usage,
    activeSeconds: 5,
    outcome,
    hasPr: false,
  });

  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0]?.callSite, "grouping");
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0]?.outcome, "awaiting_human");
});

test("setAiUsageSink supports async sink methods and swallows metering failures", async () => {
  const calls: string[] = [];
  setAiUsageSink({
    async recordTokenUsage(input) {
      calls.push(input.callSite);
    },
    async recordAgentRunCompletion() {
      throw new Error("sink failed");
    },
  });

  await recordTokenUsage({ orgId: "o", model: "m", callSite: "digest", usage });
  assert.deepEqual(calls, ["digest"]);
  await recordAgentRunCompletion({
    orgId: "o",
    model: "m",
    callSite: "agent_run",
    usage,
    activeSeconds: 5,
    outcome: "failed",
    hasPr: false,
  });
});

test("resetAiUsageSink restores the no-op sink", async () => {
  const { sink, tokenCalls } = recordingSink();
  setAiUsageSink(sink);
  resetAiUsageSink();

  await recordTokenUsage({ orgId: "o", model: "m", callSite: "merge", usage });

  assert.equal(tokenCalls.length, 0);
});

test("initAiUsageSink is a no-op when AI_USAGE_SINK_MODULE is unset", async () => {
  Reflect.deleteProperty(process.env, "AI_USAGE_SINK_MODULE");
  await initAiUsageSink();

  const { sink, tokenCalls } = recordingSink();
  // The no-op sink should still be active; installing our own afterward proves
  // init didn't replace it with something unexpected.
  setAiUsageSink(sink);
  await recordTokenUsage({ orgId: "o", model: "m", callSite: "autorecovery", usage });
  assert.equal(tokenCalls.length, 1);
});

test("initAiUsageSink loads and installs a sink from the configured module", async () => {
  // A data: module that records its calls onto globalThis so the test can read
  // them back across the dynamic import boundary.
  (globalThis as Record<string, unknown>).__aiUsageProbe = [];
  process.env.AI_USAGE_SINK_MODULE =
    "data:text/javascript,const calls = globalThis.__aiUsageProbe;" +
    "export const aiUsageSink = { recordTokenUsage: (i) => calls.push(i.callSite), recordAgentRunCompletion: () => {} };";

  await initAiUsageSink();
  await recordTokenUsage({ orgId: "o", model: "m", callSite: "digest", usage });

  assert.deepEqual((globalThis as Record<string, unknown>).__aiUsageProbe, ["digest"]);
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "__aiUsageProbe");
});

test("initAiUsageSink rejects a module without a valid sink export", async () => {
  process.env.AI_USAGE_SINK_MODULE = "data:text/javascript,export const nope = 1;";
  await assert.rejects(() => initAiUsageSink(), /must export an AiUsageSink/);
});

test("sumUsage aggregates across snake_case/camelCase and ignores unknown keys", () => {
  const total = sumUsage([
    { input_tokens: 10, output_tokens: 20 },
    { inputTokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 7 },
    null,
    // cacheReadTokens is the output field name, not a recognized input alias —
    // it must be ignored rather than double-counted.
    { cacheReadTokens: 1 },
  ]);
  assert.deepEqual(total, {
    inputTokens: 15,
    outputTokens: 20,
    cacheReadTokens: 3,
    cacheCreationTokens: 7,
  });
});

test("isProjectSpendCapExceeded returns false when no sink implements the check", async () => {
  // Default no-op sink has no isProjectSpendCapExceeded — must fail open.
  assert.equal(await isProjectSpendCapExceeded("any-project-id"), false);
});

test("isProjectSpendCapExceeded delegates to the active sink and returns its result", async () => {
  setAiUsageSink({
    recordTokenUsage() {},
    recordAgentRunCompletion() {},
    isProjectSpendCapExceeded: (projectId) => projectId === "capped-project",
  });
  assert.equal(await isProjectSpendCapExceeded("capped-project"), true);
  assert.equal(await isProjectSpendCapExceeded("other-project"), false);
});

test("isProjectSpendCapExceeded fails open when the sink throws", async () => {
  setAiUsageSink({
    recordTokenUsage() {},
    recordAgentRunCompletion() {},
    isProjectSpendCapExceeded: () => {
      throw new Error("cap check exploded");
    },
  });
  // Must return false (fail-open) rather than propagating the error.
  assert.equal(await isProjectSpendCapExceeded("any-project"), false);
});
