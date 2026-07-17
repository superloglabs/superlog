import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { type GroupingLLMClient, runGroupingAgent } from "./agent.js";
import type { GroupingCandidateIncident, GroupingNewIssue } from "./domain.js";

function makeMessage(blocks: Anthropic.Messages.ContentBlock[]): Anthropic.Messages.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
    content: blocks,
    container: null,
  } as unknown as Anthropic.Messages.Message;
}

function toolUse(name: string, input: unknown, id = "tu_1"): Anthropic.Messages.ToolUseBlock {
  return { type: "tool_use", name, input: input as object, id } as Anthropic.Messages.ToolUseBlock;
}

function textBlock(text: string): Anthropic.Messages.ContentBlock {
  return { type: "text", text, citations: null } as unknown as Anthropic.Messages.ContentBlock;
}

function makeCandidate(
  id: string,
  overrides: Partial<GroupingCandidateIncident> = {},
): GroupingCandidateIncident {
  return {
    id,
    title: "DB unreachable",
    service: "api",
    firstSeen: "2026-05-22T00:00:00Z",
    lastSeen: "2026-05-23T00:00:00Z",
    issueCount: 1,
    representative: {
      exceptionType: "ECONNREFUSED",
      message: "conn refused",
      topFrame: "db.query",
      normalizedFrames: ["db.query"],
      traceId: "t1",
      spanId: "s1",
      resourceAttrs: { "deployment.environment": "production" },
    },
    ...overrides,
  };
}

const NEW_ISSUE: GroupingNewIssue = {
  id: "new-1",
  title: "ECONNREFUSED to db",
  service: "api",
  exceptionType: "ECONNREFUSED",
  message: "conn refused",
  topFrame: "db.query",
  normalizedFrames: ["db.query"],
  stacktrace: null,
  traceId: null,
  spanId: null,
};

function makeDeps(
  responses: Array<Anthropic.Messages.ContentBlock[]>,
  overrides: Partial<{
    maxIterations: number;
    accountantCalls: Array<{ input: number; output: number }>;
    accountantRejects: boolean;
  }> = {},
) {
  let turn = 0;
  const client: GroupingLLMClient = {
    async send() {
      const blocks = responses[turn] ?? responses[responses.length - 1];
      turn += 1;
      return makeMessage(blocks ?? []);
    },
  };
  const accountantCalls = overrides.accountantCalls ?? [];
  return {
    client,
    model: "test-model",
    maxIterations: overrides.maxIterations ?? 5,
    accountant: {
      async record(input: { usage: { inputTokens: number; outputTokens: number } }) {
        if (overrides.accountantRejects) throw new Error("metering unavailable");
        accountantCalls.push({ input: input.usage.inputTokens, output: input.usage.outputTokens });
      },
    },
  };
}

test("runGroupingAgent: immediate decide_grouping standalone → standalone verdict", async () => {
  const deps = makeDeps([
    [toolUse("decide_grouping", { decision: "standalone", evidence: "Nothing in common" }, "t1")],
  ]);
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.deepEqual(verdict, { decision: "standalone", evidence: "Nothing in common" });
});

test("runGroupingAgent: join requires prior inspect_incident (else the tool result is is_error and loop continues)", async () => {
  // Turn 1: try to join "a" without inspecting → error.
  // Turn 2: inspect_incident "a".
  // Turn 3: decide_grouping join "a" with sufficient evidence.
  const deps = makeDeps([
    [
      toolUse(
        "decide_grouping",
        {
          decision: "join",
          incidentId: "a",
          evidence: "trace ids are identical between the two errors",
        },
        "t_join_first",
      ),
    ],
    [toolUse("inspect_incident", { incident_id: "a" }, "t_inspect")],
    [
      toolUse(
        "decide_grouping",
        {
          decision: "join",
          incidentId: "a",
          evidence: "trace ids are identical between the two errors",
        },
        "t_join_again",
      ),
    ],
  ]);
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.equal(verdict.decision, "join");
  if (verdict.decision === "join") {
    assert.equal(verdict.incidentId, "a");
    assert.equal(verdict.evidence, "trace ids are identical between the two errors");
  }
});

test("runGroupingAgent: malformed decide_grouping input → is_error result, agent gets another shot", async () => {
  const deps = makeDeps([
    [toolUse("decide_grouping", { decision: "yes-maybe" }, "t_bad")],
    [toolUse("decide_grouping", { decision: "standalone", evidence: "ok" }, "t_good")],
  ]);
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.deepEqual(verdict, { decision: "standalone", evidence: "ok" });
});

test("runGroupingAgent: search → inspect → decide chain", async () => {
  const deps = makeDeps([
    [toolUse("search_incidents", { query: "db" }, "t_search")],
    [toolUse("inspect_incident", { incident_id: "a" }, "t_inspect")],
    [
      toolUse(
        "decide_grouping",
        {
          decision: "join",
          incidentId: "a",
          evidence: "both fail on the same upstream postgres host and port",
        },
        "t_decide",
      ),
    ],
  ]);
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.equal(verdict.decision, "join");
});

test("runGroupingAgent: text-only fallback parses JSON verdict from text", async () => {
  const deps = makeDeps([
    [
      textBlock(
        JSON.stringify({
          decision: "join",
          incidentId: "a",
          evidence: "very strong evidence with at least 20 chars yes",
        }),
      ),
    ],
  ]);
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.equal(verdict.decision, "join");
});

test("runGroupingAgent: text-only with non-JSON returns standalone with explanatory evidence", async () => {
  const deps = makeDeps([[textBlock("I'd rather not say")]]);
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.deepEqual(verdict, {
    decision: "standalone",
    evidence: "Model did not call a grouping tool.",
  });
});

test("runGroupingAgent: exhausts iteration budget → standalone with budget message", async () => {
  // The agent only ever searches.
  const deps = makeDeps([[toolUse("search_incidents", { query: "x" }, "loop")]], {
    maxIterations: 2,
  });
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.deepEqual(verdict, {
    decision: "standalone",
    evidence: "Grouping agent exhausted its tool-use budget without a valid decision.",
  });
});

test("runGroupingAgent: records token usage every iteration", async () => {
  const calls: Array<{ input: number; output: number }> = [];
  const deps = makeDeps(
    [
      [toolUse("search_incidents", { query: "x" }, "t1")],
      [toolUse("decide_grouping", { decision: "standalone" }, "t2")],
    ],
    { accountantCalls: calls },
  );
  await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.equal(calls.length, 2);
});

test("runGroupingAgent: metering failures do not abort the grouping decision", async () => {
  const deps = makeDeps(
    [[toolUse("decide_grouping", { decision: "standalone", evidence: "Nothing in common" }, "t1")]],
    { accountantRejects: true },
  );

  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );

  assert.deepEqual(verdict, { decision: "standalone", evidence: "Nothing in common" });
});

test("runGroupingAgent: tells the decision model to inspect correlated bursts before defaulting standalone", async () => {
  let systemPrompt = "";
  const client: GroupingLLMClient = {
    async send(input) {
      systemPrompt = input.system;
      return makeMessage([
        toolUse(
          "decide_grouping",
          { decision: "standalone", evidence: "No shared root cause" },
          "t1",
        ),
      ]);
    },
  };

  await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    {
      client,
      model: "test-model",
      maxIterations: 1,
      accountant: { record() {} },
    },
  );

  assert.match(
    systemPrompt,
    /When several issues begin within the same short window and share a dependency or failure class, inspect them as a burst before deciding\./,
  );
  assert.match(
    systemPrompt,
    /Prefer joining when a single plausible deployment or configuration change explains all symptoms\./,
  );
  assert.match(
    systemPrompt,
    /Only join when inspected evidence supports that shared explanation; otherwise return standalone\./,
  );
});
