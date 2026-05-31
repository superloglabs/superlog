import type { AgentRunResult, IncidentSeverity, schema } from "@superlog/db";

const SEVERITY_VALUES: ReadonlySet<IncidentSeverity> = new Set(["SEV-1", "SEV-2", "SEV-3"]);

export function normalizeSeverity(input: unknown): IncidentSeverity | null {
  if (typeof input !== "string") return null;
  const candidate = input.trim().toUpperCase().replace(/\s+/g, "");
  return SEVERITY_VALUES.has(candidate as IncidentSeverity)
    ? (candidate as IncidentSeverity)
    : null;
}

const NOISE_REASONS: ReadonlySet<schema.IncidentNoiseReason> = new Set([
  "cosmetic_log_only",
  "lifecycle_signal",
  "self_telemetry",
  "expected_third_party",
  "confusing_log_no_impact",
]);

const RESOLUTION_REASONS: ReadonlySet<schema.IncidentResolutionReason> = new Set([
  "fixed_in_current_code",
  "transient_condition_cleared",
  "upstream_recovered",
]);

export function normalizeNoiseReason(input: unknown): schema.IncidentNoiseReason | null {
  if (typeof input !== "string") return null;
  const candidate = input.trim().toLowerCase();
  return NOISE_REASONS.has(candidate as schema.IncidentNoiseReason)
    ? (candidate as schema.IncidentNoiseReason)
    : null;
}

export function normalizeResolutionReason(input: unknown): schema.IncidentResolutionReason | null {
  if (typeof input !== "string") return null;
  const candidate = input.trim().toLowerCase();
  return RESOLUTION_REASONS.has(candidate as schema.IncidentResolutionReason)
    ? (candidate as schema.IncidentResolutionReason)
    : null;
}

export function noiseReasonLabel(reason: schema.IncidentNoiseReason): string {
  switch (reason) {
    case "cosmetic_log_only":
      return "cosmetic log only";
    case "lifecycle_signal":
      return "lifecycle signal";
    case "self_telemetry":
      return "self-telemetry";
    case "expected_third_party":
      return "expected third-party response";
    case "confusing_log_no_impact":
      return "recovered/no impact";
  }
}

export function resolutionReasonLabel(reason: schema.IncidentResolutionReason): string {
  switch (reason) {
    case "fixed_in_current_code":
      return "fixed in current code";
    case "transient_condition_cleared":
      return "transient condition cleared";
    case "upstream_recovered":
      return "upstream recovered";
  }
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
