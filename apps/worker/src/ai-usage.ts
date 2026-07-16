// AI usage plumbing. This module carries raw token counts and call-site labels
// to a pluggable sink; it does NOT know about pricing, USD cost, or any spend
// dashboards. The default sink is a no-op, so a stock build emits nothing.
//
// Deployments that want cost metering register a sink module via the
// AI_USAGE_SINK_MODULE env var (resolved at worker boot by initAiUsageSink),
// mirroring the AGENT_RUNNER_ANTHROPIC_MODULE seam in
// infra/agent-runner/backend.ts. The sink implementation lives outside this
// repo.

import { logger } from "./logger.js";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

// Where in the worker a model call originated. These mirror the worker's own
// feature modules (digest.ts, grouping.ts, …), so they disclose nothing the
// file layout doesn't already.
export type CallSite =
  | "agent_run"
  | "agent_chat"
  | "anomaly_scanner"
  | "digest"
  | "grouping"
  | "merge"
  | "autorecovery"
  | "topology";

export type AgentRunOutcome =
  | "complete_with_pr"
  | "complete_no_pr"
  | "failed"
  | "awaiting_human"
  | "awaiting_events";

export type RecordTokenUsageInput = {
  orgId: string;
  orgName?: string | null;
  projectId?: string | null;
  model: string;
  callSite: CallSite;
  usage: TokenUsage;
};

export type RecordAgentRunCompletionInput = RecordTokenUsageInput & {
  incidentId?: string | null;
  activeSeconds: number;
  outcome: AgentRunOutcome;
  hasPr: boolean;
};

type MaybePromise<T> = T | Promise<T>;

export interface AiUsageSink {
  recordTokenUsage(input: RecordTokenUsageInput): MaybePromise<void>;
  recordAgentRunCompletion(input: RecordAgentRunCompletionInput): MaybePromise<void>;
}

const noopSink: AiUsageSink = {
  recordTokenUsage() {},
  recordAgentRunCompletion() {},
};

let activeSink: AiUsageSink = noopSink;

export function setAiUsageSink(sink: AiUsageSink): void {
  activeSink = sink;
}

let initialized = false;

// Test/teardown helper: drop back to the no-op sink and allow re-init.
export function resetAiUsageSink(): void {
  activeSink = noopSink;
  initialized = false;
}

// Resolve and install the configured usage sink. Called once at worker boot.
// Without AI_USAGE_SINK_MODULE set the no-op sink stays in place — that's the
// expected path for stock / self-hosted builds.
export async function initAiUsageSink(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const specifier = process.env.AI_USAGE_SINK_MODULE;
  if (!specifier) return;
  const mod = (await import(specifier)) as { aiUsageSink?: unknown; default?: unknown };
  const sink = mod.aiUsageSink ?? mod.default;
  if (!isAiUsageSink(sink)) {
    throw new Error(
      "configured AI_USAGE_SINK_MODULE must export an AiUsageSink as aiUsageSink or default",
    );
  }
  setAiUsageSink(sink);
}

function isAiUsageSink(value: unknown): value is AiUsageSink {
  if (!value || typeof value !== "object") return false;
  const sink = value as Partial<AiUsageSink>;
  return (
    typeof sink.recordTokenUsage === "function" &&
    typeof sink.recordAgentRunCompletion === "function"
  );
}

// Forwarders the worker's feature modules call. They delegate to whatever sink
// is currently installed (no-op unless a sink module was configured at boot).
export async function recordTokenUsage(input: RecordTokenUsageInput): Promise<void> {
  try {
    await activeSink.recordTokenUsage(input);
  } catch (err) {
    logger.error(
      {
        scope: "ai_usage",
        callSite: input.callSite,
        orgId: input.orgId,
        projectId: input.projectId,
        err: err instanceof Error ? err.message : String(err),
      },
      "AI usage sink failed while recording token usage",
    );
  }
}

export async function recordAgentRunCompletion(
  input: RecordAgentRunCompletionInput,
): Promise<void> {
  try {
    await activeSink.recordAgentRunCompletion(input);
  } catch (err) {
    logger.error(
      {
        scope: "ai_usage",
        callSite: input.callSite,
        orgId: input.orgId,
        projectId: input.projectId,
        incidentId: input.incidentId,
        outcome: input.outcome,
        err: err instanceof Error ? err.message : String(err),
      },
      "AI usage sink failed while recording agent run completion",
    );
  }
}

// Aggregate model usage objects into the shape the sink records. Tolerant of
// missing fields: long-running and one-shot responses may differ in casing or
// omit cache fields entirely. Generic token math — no pricing here.
export function sumUsage(parts: Array<Record<string, unknown> | null | undefined>): TokenUsage {
  let inputT = 0;
  let outputT = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  for (const part of parts) {
    if (!part) continue;
    inputT += pickNumber(part, ["input_tokens", "inputTokens"]);
    outputT += pickNumber(part, ["output_tokens", "outputTokens"]);
    cacheRead += pickNumber(part, [
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cache_read_tokens",
    ]);
    cacheCreate += pickNumber(part, [
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
      "cache_creation_tokens",
    ]);
  }
  return {
    inputTokens: inputT,
    outputTokens: outputT,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
  };
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}
