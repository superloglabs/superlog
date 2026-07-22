// Grouping LLM tool-use loop. The dispatcher and parsers live in
// candidate-search.ts / domain.ts; this file is just the orchestration.

import type Anthropic from "@anthropic-ai/sdk";
import {
  inspectCandidate,
  listIncidentFacets,
  listIncidentTitles,
  searchCandidates,
} from "./candidate-search.js";
import {
  type GroupingCandidateIncident,
  type GroupingNewIssue,
  type GroupingVerdict,
  parseDecisionToolInput,
  parseVerdictFromText,
} from "./domain.js";
import { buildInitialUserMessage } from "./initial-message.js";
import { GROUPING_SYSTEM_PROMPT, GROUPING_TOOLS } from "./tools.js";

// Abstraction over the Anthropic SDK so tests can substitute canned
// responses. The eval harness keeps using the real client via
// `analyzeIssueGroupingWithClient` in the facade, which adapts the SDK
// to this shape.
export type GroupingLLMClient = {
  send(input: {
    model: string;
    system: string;
    tools: Anthropic.Messages.Tool[];
    toolChoice: Anthropic.Messages.ToolChoice;
    messages: Anthropic.Messages.MessageParam[];
    maxTokens: number;
    temperature: number;
  }): Promise<Anthropic.Messages.Message>;
};

export type GroupingTokenAccountant = {
  record(input: {
    model: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    };
  }): void | Promise<void>;
};

export type RunGroupingAgentInput = {
  projectName: string;
  newIssue: GroupingNewIssue;
  candidates: GroupingCandidateIncident[];
};

export type RunGroupingAgentDeps = {
  client: GroupingLLMClient;
  model: string;
  accountant: GroupingTokenAccountant;
  maxIterations: number;
};

function extractText(message: Anthropic.Messages.Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

export async function runGroupingAgent(
  input: RunGroupingAgentInput,
  deps: RunGroupingAgentDeps,
): Promise<GroupingVerdict> {
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
  const conversation: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildInitialUserMessage(input) },
  ];
  const inspectedCandidateIds = new Set<string>();

  for (let iter = 0; iter < deps.maxIterations; iter++) {
    const message = await deps.client.send({
      model: deps.model,
      system: GROUPING_SYSTEM_PROMPT,
      tools: GROUPING_TOOLS,
      toolChoice: { type: "any" },
      messages: conversation,
      maxTokens: 700,
      temperature: 0,
    });

    try {
      await deps.accountant.record({
        model: deps.model,
        usage: {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
          cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? 0,
        },
      });
    } catch {
      // Token accounting is best-effort; grouping decisions must not fail just
      // because the optional usage sink is down.
    }

    const toolUses = message.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) {
      // The model may opt out of tools and reply with raw verdict JSON —
      // honour it (including standalone without evidence). Anything that
      // doesn't parse as a verdict is a mechanical failure, not a decision.
      const parsed = parseVerdictFromText(extractText(message), candidateIds);
      if (parsed) return parsed;
      return {
        decision: "standalone",
        evidence: "Model did not call a grouping tool.",
        mechanicalFailure: "no_tool_call",
      };
    }

    conversation.push({ role: "assistant", content: message.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    let terminal: GroupingVerdict | null = null;

    for (const toolUse of toolUses) {
      const dispatch = dispatchTool(toolUse, input.candidates, candidateIds, inspectedCandidateIds);
      if (dispatch.kind === "terminal") {
        terminal = dispatch.verdict;
        break;
      }
      toolResults.push(dispatch.result);
    }

    if (terminal) return terminal;
    conversation.push({ role: "user", content: toolResults });
  }

  return {
    decision: "standalone",
    evidence: "Grouping agent exhausted its tool-use budget without a valid decision.",
    mechanicalFailure: "budget_exhausted",
  };
}

type DispatchResult =
  | { kind: "terminal"; verdict: GroupingVerdict }
  | { kind: "continue"; result: Anthropic.Messages.ToolResultBlockParam };

function dispatchTool(
  toolUse: Anthropic.Messages.ToolUseBlock,
  candidates: GroupingCandidateIncident[],
  candidateIds: ReadonlySet<string>,
  inspectedCandidateIds: Set<string>,
): DispatchResult {
  switch (toolUse.name) {
    case "decide_grouping":
      return dispatchDecide(toolUse, candidateIds, inspectedCandidateIds);
    case "search_incidents":
      return {
        kind: "continue",
        result: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(searchCandidates(candidates, toolUse.input)),
        },
      };
    case "list_incident_titles":
      return {
        kind: "continue",
        result: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(listIncidentTitles(candidates, toolUse.input)),
        },
      };
    case "list_incident_facets":
      return {
        kind: "continue",
        result: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(listIncidentFacets(candidates)),
        },
      };
    case "inspect_incident": {
      const obj =
        toolUse.input && typeof toolUse.input === "object"
          ? (toolUse.input as Record<string, unknown>)
          : {};
      const incidentId = typeof obj.incident_id === "string" ? obj.incident_id : "";
      if (candidateIds.has(incidentId)) inspectedCandidateIds.add(incidentId);
      return {
        kind: "continue",
        result: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(inspectCandidate(candidates, toolUse.input)),
        },
      };
    }
    default:
      return {
        kind: "continue",
        result: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        },
      };
  }
}

function dispatchDecide(
  toolUse: Anthropic.Messages.ToolUseBlock,
  candidateIds: ReadonlySet<string>,
  inspectedCandidateIds: ReadonlySet<string>,
): DispatchResult {
  const obj =
    toolUse.input && typeof toolUse.input === "object"
      ? (toolUse.input as Record<string, unknown>)
      : {};
  const incidentId = typeof obj.incidentId === "string" ? obj.incidentId : "";

  // Domain invariant: a join must follow an inspect_incident call for that
  // target. The model has access to the data via search_incidents, but
  // requiring an inspect makes it stop and *commit* to one candidate
  // before claiming a shared root cause.
  if (obj.decision === "join" && !inspectedCandidateIds.has(incidentId)) {
    return {
      kind: "continue",
      result: {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content:
          "Invalid decide_grouping input. Before joining, call inspect_incident for that incidentId.",
        is_error: true,
      },
    };
  }

  const verdict = parseDecisionToolInput(toolUse.input, candidateIds);
  if (verdict) return { kind: "terminal", verdict };

  return {
    kind: "continue",
    result: {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content:
        "Invalid decide_grouping input. Required: decision='standalone' or decision='join' with a known incidentId and >=20 chars of evidence.",
      is_error: true,
    },
  };
}

// Adapter from the real Anthropic SDK to our injectable client shape.
export function asGroupingLLMClient(client: Pick<Anthropic, "messages">): GroupingLLMClient {
  return {
    async send(input) {
      return client.messages.create({
        model: input.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        system: input.system,
        tools: input.tools,
        tool_choice: input.toolChoice,
        messages: input.messages,
      });
    },
  };
}
