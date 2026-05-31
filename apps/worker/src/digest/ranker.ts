import type Anthropic from "@anthropic-ai/sdk";
import {
  buildRankingUserMessage,
  type DigestCandidate,
  type DigestPick,
  DIGEST_SYSTEM_PROMPT,
  parsePicks,
  TOP_N,
  trivialPicks,
} from "./domain.js";

export type DigestLLMClient = {
  send(input: {
    model: string;
    system: string;
    messages: Anthropic.Messages.MessageParam[];
    maxTokens: number;
    temperature: number;
  }): Promise<Anthropic.Messages.Message>;
};

export type DigestTokenAccountant = {
  record(input: {
    model: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    };
  }): void;
};

export type DigestLogger = {
  warn(obj: Record<string, unknown>, msg?: string): void;
};

export type RankerDeps = {
  client: DigestLLMClient;
  model: string;
  accountant: DigestTokenAccountant;
  logger: DigestLogger;
};

function extractText(message: Anthropic.Messages.Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

// Returns up to TOP_N picks. Short-circuits the LLM when there are
// already ≤ TOP_N candidates (nothing to rank), and falls back to
// recency when the LLM returns unparseable JSON.
export async function rankCandidates(
  candidates: DigestCandidate[],
  deps: RankerDeps,
): Promise<DigestPick[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= TOP_N) return trivialPicks(candidates);

  const message = await deps.client.send({
    model: deps.model,
    system: DIGEST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildRankingUserMessage(candidates) }],
    maxTokens: 800,
    temperature: 0,
  });
  deps.accountant.record({
    model: deps.model,
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
      cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? 0,
    },
  });
  const text = extractText(message);
  const validIds = new Set(candidates.map((c) => c.agentRunId));
  const picks = parsePicks(text, validIds);
  if (picks.length === 0) {
    deps.logger.warn(
      { scope: "digest", raw: text.slice(0, 300) },
      "digest LLM returned unparseable picks; falling back to recency",
    );
    return trivialPicks(candidates.slice(0, TOP_N));
  }
  return picks;
}

// Adapter from the real Anthropic SDK.
export function asDigestLLMClient(client: Pick<Anthropic, "messages">): DigestLLMClient {
  return {
    async send(input) {
      return client.messages.create({
        model: input.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        system: input.system,
        messages: input.messages,
      });
    },
  };
}
