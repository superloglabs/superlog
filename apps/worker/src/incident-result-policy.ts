import type { AgentRunResult, IncidentSeverity, schema } from "@superlog/db";

const SEVERITY_VALUES: ReadonlySet<IncidentSeverity> = new Set(["SEV-1", "SEV-2", "SEV-3"]);

export function normalizeSeverity(input: unknown): IncidentSeverity | null {
  if (typeof input !== "string") return null;
  const candidate = input.trim().toUpperCase().replace(/\s+/g, "");
  return SEVERITY_VALUES.has(candidate as IncidentSeverity)
    ? (candidate as IncidentSeverity)
    : null;
}

// Reasons are free text in the current contract. These label maps cover the
// legacy enum values still present in stored rows and produced by pre-cutover
// sessions; anything else is rendered as-is.
const LEGACY_NOISE_REASON_LABELS: Record<string, string> = {
  cosmetic_log_only: "cosmetic log only",
  lifecycle_signal: "lifecycle signal",
  self_telemetry: "self-telemetry",
  expected_third_party: "expected third-party response",
  confusing_log_no_impact: "recovered/no impact",
};

const LEGACY_RESOLUTION_REASON_LABELS: Record<string, string> = {
  fixed_in_current_code: "fixed in current code",
  transient_condition_cleared: "transient condition cleared",
  upstream_recovered: "upstream recovered",
};

export function normalizeNoiseReason(input: unknown): schema.IncidentNoiseReason | null {
  if (typeof input !== "string") return null;
  const candidate = input.trim();
  return candidate.length > 0 ? candidate : null;
}

export function normalizeResolutionReason(input: unknown): schema.IncidentResolutionReason | null {
  if (typeof input !== "string") return null;
  const candidate = input.trim();
  return candidate.length > 0 ? candidate : null;
}

export function noiseReasonLabel(reason: schema.IncidentNoiseReason): string {
  return LEGACY_NOISE_REASON_LABELS[reason] ?? reason;
}

export function resolutionReasonLabel(reason: schema.IncidentResolutionReason): string {
  return LEGACY_RESOLUTION_REASON_LABELS[reason] ?? reason;
}

export function completedNoiseReason(result: AgentRunResult): schema.IncidentNoiseReason | null {
  return result.state === "complete"
    ? normalizeNoiseReason(result.noiseClassification?.reason)
    : null;
}

export function completedResolutionReason(
  result: AgentRunResult,
): schema.IncidentResolutionReason | null {
  return result.state === "complete"
    ? normalizeResolutionReason(result.resolutionClassification?.reason)
    : null;
}
