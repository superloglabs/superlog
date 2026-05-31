import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  type AutorecoveryLLMClient,
  type AutorecoveryLogger,
  type AutorecoveryMetricsTools,
  type AutorecoveryTokenAccountant,
  type RunAgentDeps,
  runAutorecoveryAgent,
} from "./agent.js";
import type { CandidateIncident } from "./domain.js";

const NOW = new Date("2026-05-23T10:00:00Z");

function makeCandidate(): CandidateIncident {
  return {
    id: "inc-1",
    projectId: "proj-1",
    title: "Errors",
    codename: "blue-eel",
    service: "api",
    firstSeen: new Date("2026-05-22T00:00:00Z"),
    lastSeen: new Date("2026-05-23T02:00:00Z"),
    issueCount: 3,
    issueSignatures: [{ exceptionType: "Error" }],
    slackChannelId: null,
    slackThreadTs: null,
    slackInstallationId: null,
  };
}

function makeMessage(
  blocks: Anthropic.Messages.ContentBlock[],
  usage = { input_tokens: 100, output_tokens: 50 },
): Anthropic.Messages.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-test",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
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

function makeMetrics(calls: string[]): AutorecoveryMetricsTools {
  return {
    async queryIncidentActivity(_inc, hours) {
      calls.push(`incidentActivity:${hours}`);
      return { totalEvents: 0, perHour: [], lookbackHours: hours };
    },
    async queryServiceTraffic(_inc, hours) {
      calls.push(`serviceTraffic:${hours}`);
      return { totalSpans: 1000, perHour: [], lookbackHours: hours, service: "api" };
    },
  };
}

function makeLogger(calls: string[]): AutorecoveryLogger {
  return {
    info(_obj, msg) {
      calls.push(`logger.info:${msg ?? ""}`);
    },
    warn(_obj, msg) {
      calls.push(`logger.warn:${msg ?? ""}`);
    },
  };
}

function makeAccountant(captured: Array<{ input: number; output: number }>): AutorecoveryTokenAccountant {
  return {
    record(input) {
      captured.push({
        input: input.usage.inputTokens,
        output: input.usage.outputTokens,
      });
    },
  };
}

function makeDeps(opts: {
  calls: string[];
  client: AutorecoveryLLMClient;
  accountantCaptured?: Array<{ input: number; output: number }>;
  maxIterations?: number;
}): RunAgentDeps {
  return {
    client: opts.client,
    model: "claude-test",
    metrics: makeMetrics(opts.calls),
    accountant: makeAccountant(opts.accountantCaptured ?? []),
    logger: makeLogger(opts.calls),
    maxIterations: opts.maxIterations ?? 6,
    now: () => NOW,
  };
}

test("agent: immediate propose_resolution returns parsed proposal", async () => {
  const calls: string[] = [];
  const sends: Anthropic.Messages.MessageParam[][] = [];
  const client: AutorecoveryLLMClient = {
    async send(input) {
      sends.push([...input.messages]);
      return makeMessage([
        toolUse("propose_resolution", {
          looks_resolved: true,
          confidence: "high",
          reason_code: "external dependency recovered",
          reason_text: "all good",
        }),
      ]);
    },
  };
  const accountant: Array<{ input: number; output: number }> = [];
  const deps = makeDeps({ calls, client, accountantCaptured: accountant });

  const result = await runAutorecoveryAgent(makeCandidate(), deps);
  assert.deepEqual(result, {
    looks_resolved: true,
    confidence: "high",
    reason_code: "external dependency recovered",
    reason_text: "all good",
    evidence_summary: undefined,
  });
  assert.equal(sends.length, 1);
  assert.equal(accountant[0]?.input, 100);
});

test("agent: telemetry tool result feeds next turn, then proposal terminates", async () => {
  const calls: string[] = [];
  let turn = 0;
  const sends: Anthropic.Messages.MessageParam[][] = [];
  const client: AutorecoveryLLMClient = {
    async send(input) {
      sends.push([...input.messages]);
      turn += 1;
      if (turn === 1) {
        return makeMessage([
          toolUse("query_service_traffic", { hours: 12 }, "tu_traffic"),
        ]);
      }
      return makeMessage([
        toolUse("propose_resolution", {
          looks_resolved: true,
          confidence: "medium",
          reason_code: "transient load resolved",
          reason_text: "ok now",
        }),
      ]);
    },
  };
  const deps = makeDeps({ calls, client });

  const result = await runAutorecoveryAgent(makeCandidate(), deps);
  assert.ok(result);
  assert.equal(turn, 2);
  assert.ok(calls.includes("serviceTraffic:12"));
  // Second turn's outbound messages should include the assistant turn + tool_result.
  assert.equal(sends[1]?.length, 3);
});

test("agent: unknown tool name returns is_error result and loop continues", async () => {
  const calls: string[] = [];
  let turn = 0;
  const client: AutorecoveryLLMClient = {
    async send(input) {
      turn += 1;
      if (turn === 1) return makeMessage([toolUse("not_a_tool", {}, "tu_x")]);
      const lastUser = input.messages[input.messages.length - 1];
      assert.ok(Array.isArray(lastUser?.content));
      const block = (lastUser?.content as Anthropic.Messages.ToolResultBlockParam[])[0];
      assert.equal(block?.is_error, true);
      return makeMessage([
        toolUse("propose_resolution", {
          looks_resolved: false,
          confidence: "low",
          reason_code: "stopped recurring unknown cause",
          reason_text: "no signal",
        }),
      ]);
    },
  };
  const deps = makeDeps({ calls, client });

  const result = await runAutorecoveryAgent(makeCandidate(), deps);
  assert.equal(result?.looks_resolved, false);
});

test("agent: malformed propose_resolution input gives the model another shot", async () => {
  const calls: string[] = [];
  let turn = 0;
  const client: AutorecoveryLLMClient = {
    async send() {
      turn += 1;
      if (turn === 1) {
        return makeMessage([
          toolUse(
            "propose_resolution",
            { looks_resolved: "yes" }, // wrong type
            "tu_bad",
          ),
        ]);
      }
      return makeMessage([
        toolUse(
          "propose_resolution",
          {
            looks_resolved: true,
            confidence: "high",
            reason_code: "config or credentials fixed",
            reason_text: "fixed",
          },
          "tu_good",
        ),
      ]);
    },
  };
  const deps = makeDeps({ calls, client });

  const result = await runAutorecoveryAgent(makeCandidate(), deps);
  assert.equal(result?.confidence, "high");
  assert.equal(turn, 2);
});

test("agent: text-only reply (no tool_use) returns null and logs", async () => {
  const calls: string[] = [];
  const client: AutorecoveryLLMClient = {
    async send() {
      return makeMessage([textBlock("I refuse to use a tool")]);
    },
  };
  const deps = makeDeps({ calls, client });

  const result = await runAutorecoveryAgent(makeCandidate(), deps);
  assert.equal(result, null);
  assert.ok(calls.includes("logger.warn:agent produced no tool_use"));
});

test("agent: exhausts iteration budget without proposal returns null", async () => {
  const calls: string[] = [];
  const client: AutorecoveryLLMClient = {
    async send() {
      return makeMessage([
        toolUse("query_incident_activity", { hours: 24 }, `tu_${Math.random()}`),
      ]);
    },
  };
  const deps = makeDeps({ calls, client, maxIterations: 3 });

  const result = await runAutorecoveryAgent(makeCandidate(), deps);
  assert.equal(result, null);
  assert.ok(calls.includes("logger.warn:agent exhausted iteration budget without propose_resolution"));
});
