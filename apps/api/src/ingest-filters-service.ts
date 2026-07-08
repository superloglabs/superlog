import { z } from "zod";

// The telemetry signals each ingest source can carry. OTLP (the SDK/exporter
// path) carries all three; AWS (CloudWatch → Firehose) carries logs+metrics;
// Vercel Drains carry traces+logs; the Railway and Render API pullers carry
// logs+metrics.
export const INGEST_SOURCE_SIGNALS = {
  otlp: ["traces", "logs", "metrics"],
  aws: ["logs", "metrics"],
  vercel: ["traces", "logs"],
  railway: ["logs", "metrics"],
  render: ["logs", "metrics"],
} as const;

export type IngestSource = keyof typeof INGEST_SOURCE_SIGNALS;
export type IngestSignal = "traces" | "logs" | "metrics";

export type IngestFilterState = {
  otlp: { traces: boolean; logs: boolean; metrics: boolean };
  aws: { logs: boolean; metrics: boolean };
  vercel: { traces: boolean; logs: boolean };
  railway: { logs: boolean; metrics: boolean };
  render: { logs: boolean; metrics: boolean };
};

/** Stable key for a (source, signal) pair — matches the proxy's filter key. */
export const ingestFilterKey = (source: string, signal: string): string => `${source}:${signal}`;

/** Every valid (source, signal) pair, derived from the source→signal map. */
export function allIngestFilterPairs(): Array<{ source: IngestSource; signal: IngestSignal }> {
  return (Object.keys(INGEST_SOURCE_SIGNALS) as IngestSource[]).flatMap((source) =>
    INGEST_SOURCE_SIGNALS[source].map((signal) => ({ source, signal })),
  );
}

/**
 * Build the enabled/disabled view from the set of disabled `source:signal` keys.
 * A pair is enabled unless it appears in the disabled set (the table is sparse —
 * it only stores disabled pairs).
 */
export function deriveIngestFilterState(disabled: Set<string>): IngestFilterState {
  const on = (source: string, signal: string) => !disabled.has(ingestFilterKey(source, signal));
  return {
    otlp: {
      traces: on("otlp", "traces"),
      logs: on("otlp", "logs"),
      metrics: on("otlp", "metrics"),
    },
    aws: { logs: on("aws", "logs"), metrics: on("aws", "metrics") },
    vercel: { traces: on("vercel", "traces"), logs: on("vercel", "logs") },
    railway: { logs: on("railway", "logs"), metrics: on("railway", "metrics") },
    render: { logs: on("render", "logs"), metrics: on("render", "metrics") },
  };
}

// Full desired state on every PUT (the UI sends all toggles). `.strict()` keeps
// unknown source/signal keys from silently doing nothing.
export const ingestFilterStateSchema = z
  .object({
    otlp: z.object({ traces: z.boolean(), logs: z.boolean(), metrics: z.boolean() }).strict(),
    aws: z.object({ logs: z.boolean(), metrics: z.boolean() }).strict(),
    vercel: z.object({ traces: z.boolean(), logs: z.boolean() }).strict(),
    railway: z.object({ logs: z.boolean(), metrics: z.boolean() }).strict(),
    render: z.object({ logs: z.boolean(), metrics: z.boolean() }).strict(),
  })
  .strict();

/** The (source, signal) pairs that should be DISABLED (have a row) for a state. */
export function disabledPairsFromState(
  state: IngestFilterState,
): Array<{ source: IngestSource; signal: IngestSignal }> {
  return allIngestFilterPairs().filter(({ source, signal }) => {
    const signals = state[source] as Record<string, boolean>;
    return signals[signal] === false;
  });
}
