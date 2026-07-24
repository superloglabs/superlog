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

function suggestedRetryRange(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const candidate = input.range;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { since: "now() - INTERVAL 1 HOUR", until: "now()" };
  }

  const original = candidate as Record<string, unknown>;
  const until = typeof original.until === "string" ? original.until : undefined;
  if (!until || until.trim().toLowerCase() === "now()") {
    const since =
      typeof original.since === "string" ? original.since : undefined;
    const sinceMs = since ? Date.parse(since) : Number.NaN;
    if (since && Number.isFinite(sinceMs) && !until) {
      return {
        since,
        until: new Date(sinceMs + 60 * 60_000).toISOString(),
      };
    }
    return { since: "now() - INTERVAL 1 HOUR", until: "now()" };
  }

  const untilMs = Date.parse(until);
  if (Number.isFinite(untilMs)) {
    return {
      since: new Date(untilMs - 60 * 60_000).toISOString(),
      until,
    };
  }

  const since = typeof original.since === "string" ? original.since : undefined;
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  if (since && Number.isFinite(sinceMs)) {
    return {
      since,
      until: new Date(sinceMs + 60 * 60_000).toISOString(),
    };
  }

  return original;
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
