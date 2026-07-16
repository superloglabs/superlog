export const ANOMALY_SCANNER_CADENCE_HOURS = [1, 3, 6, 12, 24] as const;
export const ANOMALY_SCANNER_OBSERVATION_MINUTES = [15, 30, 60, 180] as const;
export const ANOMALY_SCANNER_BASELINE_HOURS = [6, 12, 24, 48, 168] as const;

export type AnomalyScannerSettingsPatch = {
  enabled?: boolean;
  cadenceHours?: number;
  observationMinutes?: number;
  baselineHours?: number;
};

export type ParsedAnomalyScannerSettingsPatch =
  | { ok: true; value: AnomalyScannerSettingsPatch }
  | { ok: false; error: string };

export function parseAnomalyScannerSettingsPatch(
  input: unknown,
): ParsedAnomalyScannerSettingsPatch {
  if (!isRecord(input)) return { ok: false, error: "body must be an object" };
  const value: AnomalyScannerSettingsPatch = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    value.enabled = input.enabled;
  }
  const cadence = parseChoice(input.cadenceHours, ANOMALY_SCANNER_CADENCE_HOURS);
  if (!cadence.ok) {
    return {
      ok: false,
      error: `cadenceHours must be one of: ${ANOMALY_SCANNER_CADENCE_HOURS.join(", ")}`,
    };
  }
  if (cadence.value !== undefined) value.cadenceHours = cadence.value;
  const observation = parseChoice(input.observationMinutes, ANOMALY_SCANNER_OBSERVATION_MINUTES);
  if (!observation.ok) {
    return {
      ok: false,
      error: `observationMinutes must be one of: ${ANOMALY_SCANNER_OBSERVATION_MINUTES.join(", ")}`,
    };
  }
  if (observation.value !== undefined) value.observationMinutes = observation.value;
  const baseline = parseChoice(input.baselineHours, ANOMALY_SCANNER_BASELINE_HOURS);
  if (!baseline.ok) {
    return {
      ok: false,
      error: `baselineHours must be one of: ${ANOMALY_SCANNER_BASELINE_HOURS.join(", ")}`,
    };
  }
  if (baseline.value !== undefined) value.baselineHours = baseline.value;
  if (Object.keys(value).length === 0) {
    return { ok: false, error: "provide at least one anomaly scanner setting" };
  }
  return { ok: true, value };
}

function parseChoice<const T extends readonly number[]>(
  value: unknown,
  choices: T,
): { ok: true; value: T[number] | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "number" && choices.includes(value)
    ? { ok: true, value: value as T[number] }
    : { ok: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeAnomalyScanRun(run: schema.AnomalyScanRun) {
  return {
    id: run.id,
    status: run.status,
    metricSeriesScanned: run.metricSeriesScanned,
    findingsCount: run.findingsCount,
    incidentsOpened: run.incidentsOpened,
    incidentsDeduped: run.incidentsDeduped,
    findings: run.findings,
    audit: run.audit,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}
import type { schema } from "@superlog/db";
