import type { schema } from "@superlog/db";

// All tunable thresholds for an autorecovery pass.
//
// Captured in a single value object so callers (the tick loop, the manual
// trigger, tests) inject one shape instead of relying on module-level env
// reads. `fromEnv()` keeps the legacy behaviour for backward compatibility.
export type AutorecoveryPolicy = {
  // How often the autorecovery pass runs over the open-incident set.
  intervalMs: number;
  // Incidents with `lastSeen` newer than this are obviously still firing.
  skipRecentActivityMs: number;
  // Freshly-opened incidents haven't had the normal investigation flow yet.
  skipRecentlyCreatedMs: number;
  // Stay quiet for this long after a dismissed proposal.
  dismissalCooldownMs: number;
  // Don't re-evaluate an incident the sweep already looked at within this
  // window (any outcome). Combined with NULLS-FIRST ordering on
  // `autorecovery_last_evaluated_at`, this rotates the sweep through the whole
  // open-incident backlog instead of re-chewing the same top slice each tick.
  reevaluationCooldownMs: number;
  // Soft cap on incidents evaluated per tick.
  maxCandidatesPerTick: number;
  // Below this we still log the agent's verdict but don't bother a human.
  proposeMinConfidence: schema.IncidentResolutionProposalConfidence;
  // Hard cap on LLM tool-use loop iterations per incident.
  maxAgentIterations: number;
};

export const CONFIDENCE_RANK: Record<schema.IncidentResolutionProposalConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function compareConfidence(
  a: schema.IncidentResolutionProposalConfidence,
  b: schema.IncidentResolutionProposalConfidence,
): number {
  return CONFIDENCE_RANK[a] - CONFIDENCE_RANK[b];
}

export function meetsConfidence(
  actual: schema.IncidentResolutionProposalConfidence,
  minimum: schema.IncidentResolutionProposalConfidence,
): boolean {
  return compareConfidence(actual, minimum) >= 0;
}

export const DEFAULT_AUTORECOVERY_POLICY: AutorecoveryPolicy = {
  intervalMs: 60 * 60 * 1000,
  skipRecentActivityMs: 60 * 60 * 1000,
  skipRecentlyCreatedMs: 2 * 60 * 60 * 1000,
  dismissalCooldownMs: 24 * 60 * 60 * 1000,
  reevaluationCooldownMs: 24 * 60 * 60 * 1000,
  // Per-tick cap on incidents evaluated. The sweep runs inline in the worker's
  // sequential tick and processes candidates one LLM call at a time, so this
  // value also bounds how long a single pass blocks telemetry ingest /
  // investigations. 50 drains the typical backlog in well under a day while
  // keeping the worst-case pass duration bounded. Crank `AUTORECOVERY_MAX_PER_TICK`
  // higher to blast through a large backlog faster — but mind that the pass
  // blocks the rest of the tick until it finishes.
  maxCandidatesPerTick: 50,
  proposeMinConfidence: "medium",
  maxAgentIterations: 6,
};

// Every policy number here is a positive count or a positive duration. A
// misconfigured env (e.g. `AUTORECOVERY_MAX_PER_TICK=-5`) should fall back
// to the safe default rather than silently producing a never-firing pass.
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function confidenceFromEnv(
  name: string,
  fallback: schema.IncidentResolutionProposalConfidence,
): schema.IncidentResolutionProposalConfidence {
  const raw = process.env[name];
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return fallback;
}

export function autorecoveryPolicyFromEnv(): AutorecoveryPolicy {
  return {
    intervalMs: numberFromEnv(
      "RESOLUTION_AUTORECOVERY_INTERVAL_MS",
      DEFAULT_AUTORECOVERY_POLICY.intervalMs,
    ),
    skipRecentActivityMs: numberFromEnv(
      "AUTORECOVERY_SKIP_ACTIVE_MS",
      DEFAULT_AUTORECOVERY_POLICY.skipRecentActivityMs,
    ),
    skipRecentlyCreatedMs: numberFromEnv(
      "AUTORECOVERY_SKIP_NEW_MS",
      DEFAULT_AUTORECOVERY_POLICY.skipRecentlyCreatedMs,
    ),
    dismissalCooldownMs: numberFromEnv(
      "AUTORECOVERY_DISMISSAL_COOLDOWN_MS",
      DEFAULT_AUTORECOVERY_POLICY.dismissalCooldownMs,
    ),
    reevaluationCooldownMs: numberFromEnv(
      "AUTORECOVERY_REEVALUATION_COOLDOWN_MS",
      DEFAULT_AUTORECOVERY_POLICY.reevaluationCooldownMs,
    ),
    maxCandidatesPerTick: numberFromEnv(
      "AUTORECOVERY_MAX_PER_TICK",
      DEFAULT_AUTORECOVERY_POLICY.maxCandidatesPerTick,
    ),
    proposeMinConfidence: confidenceFromEnv(
      "AUTORECOVERY_MIN_CONFIDENCE",
      DEFAULT_AUTORECOVERY_POLICY.proposeMinConfidence,
    ),
    maxAgentIterations: DEFAULT_AUTORECOVERY_POLICY.maxAgentIterations,
  };
}

export type ThrottleDecision =
  | { kind: "run" }
  | { kind: "skip"; reason: "interval"; lastRun: Date; sinceMs: number };

export function decideThrottle(
  lastRun: Date | null,
  now: Date,
  policy: Pick<AutorecoveryPolicy, "intervalMs">,
): ThrottleDecision {
  if (!lastRun) return { kind: "run" };
  const sinceMs = now.getTime() - lastRun.getTime();
  if (sinceMs < policy.intervalMs) {
    return { kind: "skip", reason: "interval", lastRun, sinceMs };
  }
  return { kind: "run" };
}
