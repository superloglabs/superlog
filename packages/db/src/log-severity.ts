// Deterministic log-severity detection.
//
// Some log sources never set an OTLP SeverityNumber — most notably AWS
// CloudWatch logs delivered through Firehose, which arrive with
// SeverityNumber=0. Their level lives *inside* the body, usually as a JSON
// field like `level` or `severity`. Downstream, an error only becomes an issue
// when SeverityNumber >= 17 (the otel_exceptions materialized view), so a log
// with `{"level":"error"}` and SeverityNumber=0 is silently invisible.
//
// This module parses the body and maps a configured field to a canonical OTLP
// severity. It is intentionally NON-heuristic: it only reads the keys the
// project configured, and only maps values it actually recognises (built-in
// synonyms + the project's own value map). An unknown value yields null rather
// than a guess, so we never mislabel a log's severity.

export type SeverityLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export const SEVERITY_LEVELS: readonly SeverityLevel[] = [
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "FATAL",
];

// The base SeverityNumber of each OTLP severity band (the spec gives each band
// four numbers, e.g. ERROR = 17..20; we emit the band base).
export const SEVERITY_NUMBER_BY_LEVEL: Record<SeverityLevel, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

// Built-in value → level synonyms, keyed by the lowercased raw value. Covers the
// canonical names plus the common log-framework and syslog spellings. Anything
// not here (and not in a project's own value map) is treated as unknown.
const BUILTIN_SYNONYMS: Record<string, SeverityLevel> = {
  trace: "TRACE",
  debug: "DEBUG",
  dbg: "DEBUG",
  fine: "DEBUG",
  verbose: "DEBUG",
  info: "INFO",
  information: "INFO",
  informational: "INFO",
  notice: "INFO",
  log: "INFO",
  warn: "WARN",
  warning: "WARN",
  error: "ERROR",
  err: "ERROR",
  severe: "ERROR",
  fatal: "FATAL",
  crit: "FATAL",
  critical: "FATAL",
  alert: "FATAL",
  emerg: "FATAL",
  emergency: "FATAL",
  panic: "FATAL",
};

/** Per-source severity-parsing configuration. */
export type SourceParseConfig = {
  // When false, detection is skipped for this source.
  enabled: boolean;
  // Body keys to inspect, in priority order. Dotted keys (e.g. "log.level")
  // resolve both as a nested path and as a literal flattened key.
  severityKeys: string[];
  // Raw value (matched case-insensitively) → canonical level. Takes precedence
  // over the built-in synonyms, so a project can override or extend them.
  severityValueMap: Record<string, SeverityLevel>;
};

// The ingest sources that carry logs. OTLP usually sets severity at the SDK, so
// detection only fills the gaps; AWS (CloudWatch → Firehose) is the main reason
// this exists.
export type LogParseSource = "otlp" | "aws";

export type LogParseConfig = Record<LogParseSource, SourceParseConfig>;

export const DEFAULT_SEVERITY_KEYS: readonly string[] = [
  "level",
  "severity",
  "log.level",
  "loglevel",
];

const defaultSourceConfig = (): SourceParseConfig => ({
  enabled: true,
  severityKeys: [...DEFAULT_SEVERITY_KEYS],
  severityValueMap: {},
});

export const DEFAULT_LOG_PARSE_CONFIG: LogParseConfig = {
  otlp: defaultSourceConfig(),
  aws: defaultSourceConfig(),
};

export type SeverityDetection = {
  level: SeverityLevel;
  severityNumber: number;
  severityText: string;
  matchedKey: string;
  matchedValue: string;
};

/**
 * Detect a canonical OTLP severity from a log body using the source config.
 * Returns null when parsing is disabled, the body isn't a structured object,
 * no configured key is present, or the matched value can't be mapped.
 */
export function detectLogSeverity(
  body: unknown,
  config: SourceParseConfig,
): SeverityDetection | null {
  if (!config.enabled) return null;
  const obj = coerceToObject(body);
  if (!obj) return null;

  const valueMap = normalizeValueMap(config.severityValueMap);

  for (const key of config.severityKeys) {
    const raw = lookupKey(obj, key);
    if (raw === undefined) continue;
    const level = mapValueToLevel(raw, valueMap);
    if (!level) continue; // present but unmappable — try the next key
    return {
      level,
      severityNumber: SEVERITY_NUMBER_BY_LEVEL[level],
      severityText: level,
      matchedKey: key,
      matchedValue: raw,
    };
  }
  return null;
}

/** Fill any missing fields of a (possibly partial/persisted) source config. */
export function resolveSourceParseConfig(
  config: Partial<SourceParseConfig> | null | undefined,
  _source?: LogParseSource,
): SourceParseConfig {
  const base = defaultSourceConfig();
  if (!config) return base;
  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : base.enabled,
    // Honour an explicitly-empty list (cleared every key = detection off for the
    // source); only fall back to defaults when the field is absent / not an array.
    severityKeys: Array.isArray(config.severityKeys)
      ? config.severityKeys.filter((k): k is string => typeof k === "string")
      : base.severityKeys,
    severityValueMap:
      config.severityValueMap && typeof config.severityValueMap === "object"
        ? { ...config.severityValueMap }
        : base.severityValueMap,
  };
}

/** Fill both sources of a (possibly partial/persisted) parse config. */
export function resolveLogParseConfig(
  config: Partial<LogParseConfig> | null | undefined,
): LogParseConfig {
  return {
    otlp: resolveSourceParseConfig(config?.otlp, "otlp"),
    aws: resolveSourceParseConfig(config?.aws, "aws"),
  };
}

function coerceToObject(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

// Look a key up in the object as: (1) the literal key, (2) a case-insensitive
// top-level match, (3) a dotted nested path. Returns the value as a trimmed
// string, or undefined when absent / not a scalar / blank.
function lookupKey(obj: Record<string, unknown>, key: string): string | undefined {
  const direct = scalarToString(obj[key]);
  if (direct !== undefined) return direct;

  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lowerKey) {
      const s = scalarToString(v);
      if (s !== undefined) return s;
    }
  }

  if (key.includes(".")) {
    const parts = key.split(".");
    let cur: unknown = obj;
    for (const part of parts) {
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return scalarToString(cur);
  }
  return undefined;
}

function scalarToString(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? undefined : t;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return undefined;
}

function mapValueToLevel(
  raw: string,
  valueMap: Record<string, SeverityLevel>,
): SeverityLevel | null {
  const norm = raw.trim().toLowerCase();
  if (norm in valueMap) return valueMap[norm] ?? null;
  if (norm in BUILTIN_SYNONYMS) return BUILTIN_SYNONYMS[norm] ?? null;
  const upper = norm.toUpperCase();
  if ((SEVERITY_LEVELS as readonly string[]).includes(upper)) return upper as SeverityLevel;
  return null;
}

function normalizeValueMap(
  map: Record<string, SeverityLevel>,
): Record<string, SeverityLevel> {
  const out: Record<string, SeverityLevel> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (typeof k !== "string") continue;
    if (!(SEVERITY_LEVELS as readonly string[]).includes(v)) continue;
    out[k.trim().toLowerCase()] = v;
  }
  return out;
}
