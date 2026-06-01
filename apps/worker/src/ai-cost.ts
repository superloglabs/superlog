// AI cost metering. Emits per-call and per-agent-run OTel metrics to
// Superlog so we can build dashboards of Anthropic spend per customer / model /
// call site. Token-to-USD conversion happens here using the pricing table
// below; keep it in sync with https://www.anthropic.com/pricing#api.
//
// Dashboard side: per-data-point grouping is supported via groupBy="attr:<key>"
// in apps/api/src/mcp/clickhouse.ts (see metricSeries). Resource-attribute
// filters do NOT see these dimensions, so we slice by attribute groupBy only.
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("@superlog/worker/ai-cost");

export type CallSite =
  | "agent_run"
  | "obs_orchestrator"
  | "obs_subagent"
  | "digest"
  | "grouping"
  | "merge"
  | "autorecovery";

export type AgentRunOutcome = "complete_with_pr" | "complete_no_pr" | "failed" | "awaiting_human";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

// USD per million tokens. Keep in sync with https://www.anthropic.com/pricing#api
// and reconcile periodically against the Anthropic Admin API cost report — these
// token rates are the per-call estimate; managed-agent session runtime is a
// separate dimension added in recordAgentRunCompletion (see sessionRuntimeUsd).
//   sonnet 4.6:    $3 in / $15 out / $0.30 cache read / $3.75 cache write
//   opus 4.7+:     $5 in / $25 out / $0.50 cache read / $6.25 cache write
//   opus <=4.6/4.1/4.0/3: $15 in / $75 out / $1.50 read / $18.75 write (legacy)
// 4.7 dropped Opus from $15/$75 to $5/$25, so legacy Opus IDs are priced higher.
// If a model isn't in the table we fall back to sonnet pricing and tag the
// metric with model.pricing_fallback=true so it's visible on the dashboard.
type Pricing = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
};

const SONNET: Pricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

const OPUS: Pricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 6.25,
};

// Opus 4.6 and earlier (incl. 4.1, 4.0, claude-3-opus) — before the 4.7 price cut.
const OPUS_LEGACY: Pricing = {
  inputPerMTok: 15,
  outputPerMTok: 75,
  cacheReadPerMTok: 1.5,
  cacheWritePerMTok: 18.75,
};

// Claude Managed Agents bill session runtime at $0.08 per session-hour on top of
// tokens (billed to the millisecond while status=running). estimateCostUsd above
// covers only tokens, so recordAgentRunCompletion adds this for agent runs.
const MANAGED_AGENT_RUNTIME_USD_PER_HOUR = 0.08;

export function sessionRuntimeUsd(activeSeconds: number): number {
  if (!Number.isFinite(activeSeconds) || activeSeconds <= 0) return 0;
  return (activeSeconds / 3600) * MANAGED_AGENT_RUNTIME_USD_PER_HOUR;
}

const PRICING: Array<{ match: RegExp; pricing: Pricing }> = [
  // Opus 4.7+ ($5/$25); any other Opus id (4.6/4.1/4.0/claude-3-opus) is legacy
  // ($15/$75). Order matters — the specific 4.7+ match must come first.
  { match: /opus-4-(?:[5-9]|[1-9]\d)(?=-|$)/i, pricing: OPUS },
  { match: /opus/i, pricing: OPUS_LEGACY },
  { match: /sonnet/i, pricing: SONNET },
  {
    match: /haiku/i,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  },
];

function priceFor(model: string): { pricing: Pricing; fallback: boolean } {
  for (const entry of PRICING) {
    if (entry.match.test(model)) return { pricing: entry.pricing, fallback: false };
  }
  return { pricing: SONNET, fallback: true };
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const { pricing } = priceFor(model);
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok +
      usage.cacheCreationTokens * pricing.cacheWritePerMTok) /
    1_000_000
  );
}

const inputTokens = meter.createCounter("superlog.ai.input_tokens", {
  description: "Anthropic input tokens consumed per call.",
});
const outputTokens = meter.createCounter("superlog.ai.output_tokens", {
  description: "Anthropic output tokens consumed per call.",
});
const cacheReadTokens = meter.createCounter("superlog.ai.cache_read_tokens", {
  description: "Anthropic cache-read tokens consumed per call.",
});
const cacheWriteTokens = meter.createCounter("superlog.ai.cache_write_tokens", {
  description: "Anthropic cache-creation tokens consumed per call.",
});
const costUsd = meter.createCounter("superlog.ai.cost_usd", {
  description: "Estimated Anthropic spend in USD, computed from token usage.",
  unit: "USD",
});
const agentRunSeconds = meter.createCounter("superlog.ai.agent_run_seconds", {
  description: "Managed-agent session active seconds, charged per agent run/onboarding.",
  unit: "s",
});
const agentRunCount = meter.createCounter("superlog.ai.agent_run_count", {
  description: "AgentRuns counted by terminal outcome.",
});

type BaseAttrs = {
  "tenant.org.id": string;
  "tenant.org.name"?: string;
  "tenant.project.id"?: string;
  "gen_ai.system": "anthropic";
  "gen_ai.request.model": string;
  "superlog.call_site": CallSite;
  "model.pricing_fallback"?: "true";
};

function baseAttrs(input: {
  orgId: string;
  orgName?: string | null;
  projectId?: string | null;
  model: string;
  callSite: CallSite;
}): BaseAttrs {
  const { fallback } = priceFor(input.model);
  const attrs: BaseAttrs = {
    "tenant.org.id": input.orgId,
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": input.model,
    "superlog.call_site": input.callSite,
  };
  if (input.orgName) attrs["tenant.org.name"] = input.orgName;
  if (input.projectId) attrs["tenant.project.id"] = input.projectId;
  if (fallback) attrs["model.pricing_fallback"] = "true";
  return attrs;
}

// Record raw token usage from a single API call (digest/grouping/merge or a
// summed agentRun total). Use this when you have token counts but the
// call isn't a complete agent run.
export function recordTokenUsage(input: {
  orgId: string;
  orgName?: string | null;
  projectId?: string | null;
  model: string;
  callSite: CallSite;
  usage: TokenUsage;
}): void {
  // Without orgId the data point is unattributable on the dashboard. Skip
  // rather than emit a blank tenant.org.id bucket that silently inflates a
  // mystery line. Callers that hit this path have a real bug to fix.
  if (!input.orgId) return;
  const attrs = baseAttrs(input);
  if (input.usage.inputTokens > 0) inputTokens.add(input.usage.inputTokens, attrs);
  if (input.usage.outputTokens > 0) outputTokens.add(input.usage.outputTokens, attrs);
  if (input.usage.cacheReadTokens > 0) cacheReadTokens.add(input.usage.cacheReadTokens, attrs);
  if (input.usage.cacheCreationTokens > 0)
    cacheWriteTokens.add(input.usage.cacheCreationTokens, attrs);
  const cost = estimateCostUsd(input.model, input.usage);
  if (cost > 0) costUsd.add(cost, attrs);
}

// Record a terminal agentRun / onboarding result with both token spend
// and active-seconds. outcome + hasPr go on the count so we can compute
// cost-per-PR by filtering/grouping on those dimensions on the dashboard.
export function recordAgentRunCompletion(input: {
  orgId: string;
  orgName?: string | null;
  projectId?: string | null;
  incidentId?: string | null;
  model: string;
  callSite: CallSite;
  usage: TokenUsage;
  activeSeconds: number;
  outcome: AgentRunOutcome;
  hasPr: boolean;
}): void {
  if (!input.orgId) return;
  recordTokenUsage({
    orgId: input.orgId,
    orgName: input.orgName,
    projectId: input.projectId,
    model: input.model,
    callSite: input.callSite,
    usage: input.usage,
  });
  // Managed-agent session runtime ($0.08/session-hr) is billed on top of tokens;
  // fold it into the same cost counter so cost_usd reflects true Anthropic spend.
  const runtimeUsd = sessionRuntimeUsd(input.activeSeconds);
  if (runtimeUsd > 0) costUsd.add(runtimeUsd, baseAttrs(input));
  const attrs = {
    ...baseAttrs(input),
    "superlog.outcome": input.outcome,
    "superlog.has_pr": input.hasPr ? "true" : "false",
  };
  if (input.activeSeconds > 0) agentRunSeconds.add(input.activeSeconds, attrs);
  agentRunCount.add(1, attrs);
}

// Aggregate model usage objects into the shape we record. Tolerant of missing
// fields: long-running and one-shot responses may differ in casing or omit
// cache fields entirely.
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
