import type Anthropic from "@anthropic-ai/sdk";
import {
  type CandidateIncident,
  type ProposalToolInput,
  buildInitialUserMessage,
  clampLookbackHours,
  parseProposalToolInput,
} from "./domain.js";
import type { IncidentActivity, ServiceTraffic } from "./metrics-repository.js";
import { AUTORECOVERY_SYSTEM_PROMPT, AUTORECOVERY_TOOLS } from "./tools.js";

// Abstraction over the Anthropic client so we can swap a fake in for tests.
// We only need the create() shape from messages.create.
export type AutorecoveryLLMClient = {
  send(
    input: {
      model: string;
      system: string;
      tools: Anthropic.Messages.Tool[];
      messages: Anthropic.Messages.MessageParam[];
      maxTokens: number;
      temperature: number;
    },
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Messages.Message>;
};

export type AutorecoveryTokenAccountant = {
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

export type AutorecoveryLogger = {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
};

export type AutorecoveryMetricsTools = {
  queryIncidentActivity(incident: CandidateIncident, hours: number): Promise<IncidentActivity>;
  queryServiceTraffic(incident: CandidateIncident, hours: number): Promise<ServiceTraffic>;
};

export type RunAgentDeps = {
  client: AutorecoveryLLMClient;
  model: string;
  metrics: AutorecoveryMetricsTools;
  accountant: AutorecoveryTokenAccountant;
  logger: AutorecoveryLogger;
  maxIterations: number;
  signal?: AbortSignal;
  now(): Date;
};

// Adapter that wraps the real Anthropic SDK client into the shape our agent
// expects. Lives next to the agent because it's the canonical way to wire
// production deps.
export function asLLMClient(client: Anthropic): AutorecoveryLLMClient {
  return {
    async send(input, options) {
      return client.messages.create(
        {
          model: input.model,
          max_tokens: input.maxTokens,
          temperature: input.temperature,
          system: input.system,
          tools: input.tools,
          messages: input.messages,
        },
        { signal: options?.signal },
      );
    },
  };
}

// Tool-use loop. Returns the parsed propose_resolution input, or null if the
// agent failed to call it within the iteration budget (or it produced a
// text-only reply, which we treat as a refusal).
export async function runAutorecoveryAgent(
  incident: CandidateIncident,
  deps: RunAgentDeps,
): Promise<ProposalToolInput | null> {
  const conversation: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildInitialUserMessage(incident, deps.now()) },
  ];

  for (let iter = 0; iter < deps.maxIterations; iter++) {
    const message = await deps.client.send(
      {
        model: deps.model,
        system: AUTORECOVERY_SYSTEM_PROMPT,
        tools: AUTORECOVERY_TOOLS,
        messages: conversation,
        maxTokens: 1500,
        temperature: 0,
      },
      { signal: deps.signal },
    );

    await deps.accountant.record({
      model: deps.model,
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
        cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? 0,
      },
    });

    const toolUses = message.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) {
      // Treat a text-only reply as a refusal — we never write a proposal
      // we can't ground in a structured tool call.
      deps.logger.warn(
        { scope: "autorecovery", incident_id: incident.id, iter },
        "agent produced no tool_use",
      );
      return null;
    }

    conversation.push({ role: "assistant", content: message.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    let terminal: ProposalToolInput | null = null;

    for (const toolUse of toolUses) {
      const dispatch = await dispatchTool(toolUse, incident, deps);
      if (dispatch.kind === "terminal") {
        terminal = dispatch.proposal;
        break;
      }
      toolResults.push(dispatch.result);
    }

    if (terminal) return terminal;
    conversation.push({ role: "user", content: toolResults });
  }

  deps.logger.warn(
    { scope: "autorecovery", incident_id: incident.id },
    "agent exhausted iteration budget without propose_resolution",
  );
  return null;
}

type ToolDispatchResult =
  | { kind: "terminal"; proposal: ProposalToolInput }
  | { kind: "continue"; result: Anthropic.Messages.ToolResultBlockParam };

async function dispatchTool(
  toolUse: Anthropic.Messages.ToolUseBlock,
  incident: CandidateIncident,
  deps: Pick<RunAgentDeps, "metrics">,
): Promise<ToolDispatchResult> {
  if (toolUse.name === "propose_resolution") {
    const parsed = parseProposalToolInput(toolUse.input);
    if (!parsed) {
      return {
        kind: "continue",
        result: {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content:
            "Invalid input shape. Required: looks_resolved, confidence, reason_code, reason_text.",
          is_error: true,
        },
      };
    }
    return { kind: "terminal", proposal: parsed };
  }

  if (toolUse.name === "query_incident_activity") {
    const hours = clampLookbackHours(toolUse.input);
    const data = await deps.metrics.queryIncidentActivity(incident, hours);
    return {
      kind: "continue",
      result: {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(data),
      },
    };
  }

  if (toolUse.name === "query_service_traffic") {
    const hours = clampLookbackHours(toolUse.input);
    const data = await deps.metrics.queryServiceTraffic(incident, hours);
    return {
      kind: "continue",
      result: {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(data),
      },
    };
  }

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
