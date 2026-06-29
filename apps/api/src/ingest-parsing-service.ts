// Application-layer helpers for the per-project log parse config. Validation and
// preview are kept here (pure, testable) so the HTTP handlers in index.ts stay
// thin. The actual severity-detection logic lives in @superlog/db's
// log-severity module and is shared with the proxy decode path.
import {
  detectLogSeverity,
  resolveSourceParseConfig,
  SEVERITY_LEVELS,
  type LogParseConfig,
  type SeverityDetection,
  type SeverityLevel,
  type SourceParseConfig,
} from "@superlog/db/log-severity";

const MAX_SEVERITY_KEYS = 20;
const MAX_KEY_LEN = 120;
const MAX_VALUE_MAP_ENTRIES = 200;

const isSeverityLevel = (v: unknown): v is SeverityLevel =>
  typeof v === "string" && (SEVERITY_LEVELS as readonly string[]).includes(v);

/**
 * Validate/normalize a posted source config against a fallback. Unlike
 * resolveSourceParseConfig (which fills *absent* fields with defaults), this
 * honours an explicitly-empty severityKeys list — clearing every key is a valid
 * way to turn detection off for a source — and only falls back when a field is
 * missing or the wrong type.
 */
export function sanitizeSourceParseConfig(
  input: unknown,
  fallback: SourceParseConfig,
): SourceParseConfig {
  if (!input || typeof input !== "object") return resolveSourceParseConfig(fallback);
  const obj = input as Record<string, unknown>;

  const enabled = typeof obj.enabled === "boolean" ? obj.enabled : fallback.enabled;

  let severityKeys: string[];
  if (Array.isArray(obj.severityKeys)) {
    const seen = new Set<string>();
    severityKeys = [];
    for (const raw of obj.severityKeys) {
      if (typeof raw !== "string") continue;
      const key = raw.trim().slice(0, MAX_KEY_LEN);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      severityKeys.push(key);
      if (severityKeys.length >= MAX_SEVERITY_KEYS) break;
    }
  } else {
    severityKeys = [...fallback.severityKeys];
  }

  let severityValueMap: Record<string, SeverityLevel>;
  if (obj.severityValueMap && typeof obj.severityValueMap === "object") {
    severityValueMap = {};
    let count = 0;
    for (const [k, v] of Object.entries(obj.severityValueMap as Record<string, unknown>)) {
      if (typeof k !== "string") continue;
      const key = k.trim().toLowerCase().slice(0, MAX_KEY_LEN);
      if (!key || !isSeverityLevel(v)) continue;
      severityValueMap[key] = v;
      if (++count >= MAX_VALUE_MAP_ENTRIES) break;
    }
  } else {
    severityValueMap = { ...fallback.severityValueMap };
  }

  return { enabled, severityKeys, severityValueMap };
}

export function sanitizeLogParseConfig(
  input: unknown,
  fallback: LogParseConfig,
): LogParseConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    otlp: sanitizeSourceParseConfig(obj.otlp, fallback.otlp),
    aws: sanitizeSourceParseConfig(obj.aws, fallback.aws),
  };
}

export type LogParsePreviewRow = {
  body: string;
  detection: SeverityDetection | null;
};

/** Run severity detection against each sample body for the live preview. */
export function previewLogParse(
  samples: string[],
  config: SourceParseConfig,
): LogParsePreviewRow[] {
  return samples.map((body) => ({ body, detection: detectLogSeverity(body, config) }));
}
