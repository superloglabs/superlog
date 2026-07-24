export type McpTelemetryToolName =
  | "query_logs"
  | "query_traces"
  | "query_metrics"
  | "list_services";

export type TelemetryRetryRequired = {
  status: "retry_required";
  tool: McpTelemetryToolName;
  message: string;
  retryable: true;
  suggested_input: Record<string, unknown>;
};

function isRetryableTelemetryTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as Error & {
    code?: string | number;
    type?: string;
  };

  return (
    details.name === "AbortError" ||
    details.name === "TimeoutError" ||
    details.message === "Timeout error." ||
    details.type === "TIMEOUT_EXCEEDED" ||
    details.type === "QUERY_WAS_CANCELLED" ||
    String(details.code) === "159" ||
    String(details.code) === "394"
  );
}

const HOUR_MS = 60 * 60_000;
const RELATIVE_TIME_RE =
  /^now\(\)(?:\s*-\s*INTERVAL\s+([1-9][0-9]*)\s+(SECOND|MINUTE|HOUR|DAY|WEEK))?$/i;
const UNIT_MS = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: HOUR_MS,
  DAY: 24 * HOUR_MS,
  WEEK: 7 * 24 * HOUR_MS,
} as const;

function relativeOffsetMs(value: string): number | undefined {
  const match = RELATIVE_TIME_RE.exec(value.trim().replace(/\s+/g, " "));
  if (!match) return undefined;
  if (!match[1] || !match[2]) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase() as keyof typeof UNIT_MS;
  const offset = amount * UNIT_MS[unit];
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function relativeTimeFromOffset(offsetMs: number): string {
  if (offsetMs === 0) return "now()";
  for (const unit of ["WEEK", "DAY", "HOUR", "MINUTE", "SECOND"] as const) {
    if (offsetMs % UNIT_MS[unit] === 0) {
      return `now() - INTERVAL ${offsetMs / UNIT_MS[unit]} ${unit}`;
    }
  }
  return `now() - INTERVAL ${Math.ceil(offsetMs / 1_000)} SECOND`;
}

function narrowedDuration(durationMs: number): number {
  if (durationMs > HOUR_MS) return HOUR_MS;
  return Math.max(1, Math.floor(durationMs / 2));
}

function suggestedRetryRange(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const candidate = input.range;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { since: "now() - INTERVAL 1 HOUR", until: "now()" };
  }

  const original = candidate as Record<string, unknown>;
  const since = typeof original.since === "string" ? original.since : undefined;
  const until = typeof original.until === "string" ? original.until : undefined;

  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const untilMs = until ? Date.parse(until) : Number.NaN;
  if (
    since &&
    until &&
    Number.isFinite(sinceMs) &&
    Number.isFinite(untilMs) &&
    untilMs > sinceMs
  ) {
    const duration = narrowedDuration(untilMs - sinceMs);
    return {
      since: new Date(untilMs - duration).toISOString(),
      until,
    };
  }

  const sinceOffset = since ? relativeOffsetMs(since) : undefined;
  const untilOffset = until ? relativeOffsetMs(until) : 0;
  if (
    sinceOffset !== undefined &&
    untilOffset !== undefined &&
    sinceOffset > untilOffset
  ) {
    const duration = narrowedDuration(sinceOffset - untilOffset);
    return {
      since: relativeTimeFromOffset(untilOffset + duration),
      until: until ?? "now()",
    };
  }

  if (!until || until.trim().toLowerCase() === "now()") {
    if (since && Number.isFinite(sinceMs) && !until) {
      return {
        since,
        until: new Date(sinceMs + HOUR_MS).toISOString(),
      };
    }
    return { since: "now() - INTERVAL 1 HOUR", until: "now()" };
  }

  if (Number.isFinite(untilMs)) {
    return {
      since: new Date(untilMs - HOUR_MS).toISOString(),
      until,
    };
  }

  if (since && Number.isFinite(sinceMs)) {
    return {
      since,
      until: new Date(sinceMs + HOUR_MS).toISOString(),
    };
  }

  return { since: "now() - INTERVAL 1 HOUR", until: "now()" };
}

export function recoverTelemetryTimeout(
  tool: McpTelemetryToolName,
  input: Record<string, unknown>,
  error: unknown,
): TelemetryRetryRequired | undefined {
  if (!isRetryableTelemetryTimeout(error)) return undefined;

  return {
    status: "retry_required",
    tool,
    message:
      "The telemetry query did not complete, but telemetry access is still available. Retry with a narrower time range and keep the same filters.",
    retryable: true,
    suggested_input: {
      ...input,
      range: suggestedRetryRange(input),
    },
  };
}

export async function executeRecoverableTelemetryQuery<T>(
  tool: McpTelemetryToolName,
  input: Record<string, unknown>,
  query: () => Promise<T>,
  onTimeout?: (error: unknown) => void,
): Promise<T | TelemetryRetryRequired> {
  try {
    return await query();
  } catch (error) {
    const recovery = recoverTelemetryTimeout(tool, input, error);
    if (!recovery) throw error;
    onTimeout?.(error);
    return recovery;
  }
}
