import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { type GroupingLLMClient, runGroupingAgent } from "./agent.js";
import {
  type GroupingCandidateIncident,
  type GroupingNewIssue,
  compactDiagnosticText,
} from "./domain.js";

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
  observedAt: "2026-07-17T10:05:00.000Z",
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

test("runGroupingAgent: inspect and join in the same model turn requires a later decision", async () => {
  let turn = 0;
  let inspectionWasVisible = false;
  const client: GroupingLLMClient = {
    async send(input) {
      turn += 1;
      if (turn === 1) {
        return makeMessage([
          toolUse("inspect_incident", { incident_id: "a" }, "inspect"),
          toolUse(
            "decide_grouping",
            {
              decision: "join",
              incidentId: "a",
              evidence: "both fail on the same upstream postgres host and port",
            },
            "premature-decision",
          ),
        ]);
      }

      inspectionWasVisible = JSON.stringify(input.messages).includes('"tool_use_id":"inspect"');
      return makeMessage([
        toolUse(
          "decide_grouping",
          {
            decision: "join",
            incidentId: "a",
            evidence: "both fail on the same upstream postgres host and port",
          },
          "later-decision",
        ),
      ]);
    },
  };

  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    {
      client,
      model: "test-model",
      maxIterations: 3,
      accountant: { record() {} },
    },
  );

  assert.equal(turn, 2);
  assert.equal(inspectionWasVisible, true);
  assert.equal(verdict.decision, "join");
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

test("runGroupingAgent: 100-candidate oversized bundler replay stays bounded and joins", async () => {
  const headline = 'Failed to resolve import "./missing.png" from "app/cart.tsx"';
  const oversizedMessage = `${headline}\nPlugin: vite:import-analysis\n${"generatedCall();".repeat(
    40_000,
  )}\nat normalizeUrl`;
  const target = makeCandidate("target", {
    title: headline,
    service: "web",
    representative: {
      exceptionType: "Error",
      message: oversizedMessage,
      topFrame: "normalizeUrl",
      normalizedFrames: ["normalizeUrl"],
      traceId: null,
      spanId: null,
    },
    issues: [
      {
        id: "old-issue",
        title: headline,
        service: "web",
        exceptionType: "Error",
        message: oversizedMessage,
        topFrame: "normalizeUrl",
        normalizedFrames: ["normalizeUrl"],
        traceId: null,
        spanId: null,
        lastSeen: "2026-05-23T00:00:00Z",
      },
    ],
  });
  const candidates = [
    target,
    ...Array.from({ length: 99 }, (_, index) =>
      makeCandidate(`unrelated-${index}`, {
        title: `Unrelated failure ${index}`,
        lastSeen: new Date(Date.UTC(2026, 4, 22, 0, index)).toISOString(),
      }),
    ),
  ];
  const requestChars: number[] = [];
  let turn = 0;
  const client: GroupingLLMClient = {
    async send(input) {
      requestChars.push(JSON.stringify(input.messages).length);
      turn += 1;
      if (turn === 1) {
        return makeMessage([toolUse("search_incidents", { query: "missing.png vite" }, "search")]);
      }
      if (turn === 2) {
        return makeMessage([toolUse("inspect_incident", { incident_id: "target" }, "inspect")]);
      }
      return makeMessage([
        toolUse(
          "decide_grouping",
          {
            decision: "join",
            incidentId: "target",
            evidence: "both errors are the same unresolved asset import in the same module",
          },
          "decide",
        ),
      ]);
    },
  };
  const newIssue: GroupingNewIssue = {
    ...NEW_ISSUE,
    title: headline,
    service: "web",
    exceptionType: "Error",
    message: compactDiagnosticText(oversizedMessage),
    topFrame: "normalizeUrl",
    normalizedFrames: ["normalizeUrl"],
  };

  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue, candidates },
    {
      client,
      model: "test-model",
      maxIterations: 5,
      accountant: { record() {} },
    },
  );

  assert.equal(oversizedMessage.length > 600_000, true);
  assert.deepEqual(verdict, {
    decision: "join",
    incidentId: "target",
    evidence: "both errors are the same unresolved asset import in the same module",
  });
  assert.equal(requestChars.length, 3);
  assert.ok(
    Math.max(...requestChars) < 100_000,
    `largest request was ${Math.max(...requestChars)}`,
  );
});

test("runGroupingAgent: repeated oversized inspections keep the conversation below 600 KB", async () => {
  const oversizedMessage = `Build failed\n${"generatedCall();".repeat(40_000)}\nat normalizeUrl`;
  const target = makeCandidate("target", {
    representative: {
      exceptionType: "Error",
      message: oversizedMessage,
      topFrame: "normalizeUrl",
      normalizedFrames: ["normalizeUrl"],
      traceId: null,
      spanId: null,
    },
    issues: Array.from({ length: 5 }, (_, index) => ({
      id: `old-issue-${index}`,
      title: "Build failed",
      service: "web",
      exceptionType: "Error",
      message: oversizedMessage,
      topFrame: "normalizeUrl",
      normalizedFrames: ["normalizeUrl"],
      traceId: null,
      spanId: null,
      lastSeen: "2026-05-23T00:00:00Z",
    })),
  });
  const requestChars: number[] = [];
  let turn = 0;
  const client: GroupingLLMClient = {
    async send(input) {
      requestChars.push(JSON.stringify(input.messages).length);
      turn += 1;
      if (turn <= 10) {
        return makeMessage([
          toolUse("inspect_incident", { incident_id: "target" }, `inspect-${turn}`),
        ]);
      }
      return makeMessage([
        toolUse(
          "decide_grouping",
          {
            decision: "join",
            incidentId: "target",
            evidence: "the inspected diagnostics share the same failing module and stack frame",
          },
          "decide",
        ),
      ]);
    },
  };

  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [target] },
    {
      client,
      model: "test-model",
      maxIterations: 12,
      accountant: { record() {} },
    },
  );

  assert.equal(verdict.decision, "join");
  assert.ok(
    Math.max(...requestChars) < 600_000,
    `largest request was ${Math.max(...requestChars)}`,
  );
});

test("runGroupingAgent: a retained inspection remains valid while later results are compacted", async () => {
  const oversizedMessage = `Build failed\n${"generatedCall();".repeat(40_000)}\nat normalizeUrl`;
  const oversizedCandidate = (id: string) =>
    makeCandidate(id, {
      representative: {
        exceptionType: "Error",
        message: oversizedMessage,
        topFrame: "normalizeUrl",
        normalizedFrames: ["normalizeUrl"],
        traceId: null,
        spanId: null,
      },
      issues: Array.from({ length: 5 }, (_, index) => ({
        id: `${id}-issue-${index}`,
        title: "Build failed",
        service: "web",
        exceptionType: "Error",
        message: oversizedMessage,
        topFrame: "normalizeUrl",
        normalizedFrames: ["normalizeUrl"],
        traceId: null,
        spanId: null,
        lastSeen: "2026-05-23T00:00:00Z",
      })),
    });
  const oldTarget = oversizedCandidate("old-target");
  const recentTarget = oversizedCandidate("recent-target");
  let turn = 0;
  let sawReinspectionError = false;
  const client: GroupingLLMClient = {
    async send(input) {
      turn += 1;
      if (turn === 1) {
        return makeMessage([
          toolUse("inspect_incident", { incident_id: oldTarget.id }, "inspect-old"),
        ]);
      }
      if (turn <= 10) {
        return makeMessage([
          toolUse(
            "inspect_incident",
            { incident_id: recentTarget.id },
            `inspect-recent-${turn}`,
          ),
        ]);
      }
      if (turn === 11) {
        return makeMessage([
          toolUse(
            "decide_grouping",
            {
              decision: "join",
              incidentId: oldTarget.id,
              evidence: "the old target originally showed the same module and stack frame",
            },
            "premature-decide",
          ),
        ]);
      }
      if (turn === 12) {
        sawReinspectionError = JSON.stringify(input.messages).includes(
          "Before joining, call inspect_incident",
        );
        return makeMessage([
          toolUse("inspect_incident", { incident_id: oldTarget.id }, "reinspect-old"),
        ]);
      }
      return makeMessage([
        toolUse(
          "decide_grouping",
          {
            decision: "join",
            incidentId: oldTarget.id,
            evidence: "the refreshed inspection shows the same module and stack frame",
          },
          "final-decide",
        ),
      ]);
    },
  };

  const verdict = await runGroupingAgent(
    {
      projectName: "p",
      newIssue: NEW_ISSUE,
      candidates: [oldTarget, recentTarget],
    },
    {
      client,
      model: "test-model",
      maxIterations: 14,
      accountant: { record() {} },
    },
  );

  assert.equal(turn, 11);
  assert.equal(sawReinspectionError, false);
  assert.deepEqual(verdict, {
    decision: "join",
    incidentId: oldTarget.id,
    evidence: "the old target originally showed the same module and stack frame",
  });
});

test("runGroupingAgent: preserves every inspection result from the latest tool turn", async () => {
  const oversizedMessage = `Build failed\n${"generatedCall();".repeat(40_000)}\nat normalizeUrl`;
  const candidates = Array.from({ length: 8 }, (_, candidateIndex) =>
    makeCandidate(`target-${candidateIndex}`, {
      representative: {
        exceptionType: "Error",
        message: oversizedMessage,
        topFrame: "normalizeUrl",
        normalizedFrames: ["normalizeUrl"],
        traceId: null,
        spanId: null,
      },
      issues: Array.from({ length: 5 }, (_, issueIndex) => ({
        id: `target-${candidateIndex}-issue-${issueIndex}`,
        title: "Build failed",
        service: "web",
        exceptionType: "Error",
        message: oversizedMessage,
        topFrame: "normalizeUrl",
        normalizedFrames: ["normalizeUrl"],
        traceId: null,
        spanId: null,
        lastSeen: "2026-05-23T00:00:00Z",
      })),
    }),
  );
  let turn = 0;
  let latestResultsWereVisible = false;
  let latestRequestChars = 0;
  const client: GroupingLLMClient = {
    async send(input) {
      turn += 1;
      if (turn === 1) {
        return makeMessage(
          candidates.map((candidate, index) =>
            toolUse("inspect_incident", { incident_id: candidate.id }, `inspect-${index}`),
          ),
        );
      }

      const messages = JSON.stringify(input.messages);
      latestRequestChars = messages.length;
      latestResultsWereVisible = candidates.every(
        (_, index) =>
          messages.includes(`target-${index}-issue-4`) &&
          !messages.includes(
            `\"tool_use_id\":\"inspect-${index}\",\"content\":\"[earlier tool result omitted`,
          ),
      );
      return makeMessage([
        toolUse(
          "decide_grouping",
          { decision: "standalone", evidence: "The inspected incidents are unrelated" },
          "decide",
        ),
      ]);
    },
  };

  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates },
    {
      client,
      model: "test-model",
      maxIterations: 3,
      accountant: { record() {} },
    },
  );

  assert.equal(latestResultsWereVisible, true);
  assert.ok(latestRequestChars < 550_000, `latest request was ${latestRequestChars}`);
  assert.deepEqual(verdict, {
    decision: "standalone",
    evidence: "The inspected incidents are unrelated",
  });
});

test("runGroupingAgent: inspection burst uses only the remaining conversation headroom", async () => {
  const oversizedMessage = `Build failed\n${"generatedCall();".repeat(40_000)}\nat normalizeUrl`;
  const candidates = Array.from({ length: 200 }, (_, candidateIndex) =>
    makeCandidate(`target-${candidateIndex}`, {
      title: `Build failed ${"candidate-title".repeat(65)} ${candidateIndex}`,
      representative: {
        exceptionType: "Error",
        message: oversizedMessage,
        topFrame: "normalizeUrl",
        normalizedFrames: ["normalizeUrl"],
        traceId: null,
        spanId: null,
      },
      issues: Array.from({ length: 5 }, (_, issueIndex) => ({
        id: `target-${candidateIndex}-issue-${issueIndex}`,
        title: "Build failed",
        service: "web",
        exceptionType: "Error",
        message: oversizedMessage,
        topFrame: "normalizeUrl",
        normalizedFrames: ["normalizeUrl"],
        traceId: null,
        spanId: null,
        logAttrs: { "code.file.path": "a/very/long/path/".repeat(18) },
        lastSeen: "2026-05-23T00:00:00Z",
      })),
    }),
  );
  const requestChars: number[] = [];
  let turn = 0;
  const client: GroupingLLMClient = {
    async send(input) {
      requestChars.push(JSON.stringify(input.messages).length);
      turn += 1;
      if (turn === 1) {
        return makeMessage(
          candidates.slice(0, 8).map((candidate, index) =>
            toolUse("inspect_incident", { incident_id: candidate.id }, `inspect-${index}`),
          ),
        );
      }
      return makeMessage([
        toolUse(
          "decide_grouping",
          { decision: "standalone", evidence: "The inspected incidents are unrelated" },
          "decide",
        ),
      ]);
    },
  };

  await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates },
    {
      client,
      model: "test-model",
      maxIterations: 3,
      accountant: { record() {} },
    },
  );

  assert.equal(requestChars.length, 2);
  const [initialRequestChars = Number.POSITIVE_INFINITY, inspectionRequestChars = Number.POSITIVE_INFINITY] =
    requestChars;
  assert.ok(initialRequestChars < 550_000, `initial request was ${initialRequestChars}`);
  assert.ok(inspectionRequestChars < 550_000, `inspection request was ${inspectionRequestChars}`);
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

test("runGroupingAgent: raw standalone JSON without evidence is honoured, not a failure", async () => {
  const deps = makeDeps([[textBlock('{"decision": "standalone"}')]]);
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.deepEqual(verdict, { decision: "standalone", evidence: null });
});

test("runGroupingAgent: text-only with non-JSON is a mechanical failure, not a verdict", async () => {
  const deps = makeDeps([[textBlock("I'd rather not say")]]);
  const verdict = await runGroupingAgent(
    { projectName: "p", newIssue: NEW_ISSUE, candidates: [makeCandidate("a")] },
    deps,
  );
  assert.deepEqual(verdict, {
    decision: "standalone",
    evidence: "Model did not call a grouping tool.",
    mechanicalFailure: "no_tool_call",
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
    mechanicalFailure: "budget_exhausted",
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
