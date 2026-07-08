// Per-project ingest source filter. Lets a project turn off a telemetry source
// (its OTLP/SDK exporters, or its AWS CloudWatch→Firehose stream) per signal, so
// the proxy ack-drops that data at the edge instead of ingesting it.
//
// Same discipline as the billing entitlement gate (ingest-entitlement.ts): the
// proxy is the latency-critical, shared-event-loop ingest edge, so `allows()` is
// a pure in-memory cache read that returns instantly, FAILS OPEN on anything it
// doesn't know, and only schedules a background refresh. A user's toggle taking
// a few seconds to apply is fine; a DB hiccup silently dropping telemetry is not.
import { logger } from "./logger.js";

export type IngestSource = "otlp" | "aws" | "vercel" | "railway" | "render";
export type TelemetrySignal = "traces" | "logs" | "metrics";

export const ingestFilterKey = (source: IngestSource, signal: TelemetrySignal): string =>
  `${source}:${signal}`;

export type IngestSourceFilter = {
  // Sync, hot-path. true = ingest; false only when the project has explicitly
  // disabled this (source, signal). Defaults to allow on miss/unknown/error.
  allows(projectId: string, source: IngestSource, signal: TelemetrySignal): boolean;
};

type Entry = { disabled: Set<string>; expiresAt: number };

const DEFAULT_TTL_MS = 30_000;
const ERROR_TTL_MS = 10_000; // retry sooner after an error, but don't hammer

export function createIngestSourceFilter(deps: {
  // Load the set of disabled `${source}:${signal}` keys for a project. An empty
  // set means everything is enabled (the common case).
  loadDisabled: (projectId: string) => Promise<Set<string>>;
  ttlMs?: number;
  now?: () => number;
}): IngestSourceFilter {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Set<string>();

  // Bound memory in the long-lived proxy (Map preserves insertion order, so the
  // first key is the oldest). One entry per project; 20k is far above any active
  // set within a TTL.
  const MAX_ENTRIES = 20_000;
  function setEntry(projectId: string, entry: Entry): void {
    if (!cache.has(projectId) && cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(projectId, entry);
  }

  function refresh(projectId: string): void {
    if (inflight.has(projectId)) return;
    inflight.add(projectId);
    void (async () => {
      try {
        const disabled = await deps.loadDisabled(projectId);
        setEntry(projectId, { disabled, expiresAt: now() + ttlMs });
      } catch (err) {
        // Fail open: an empty disabled set = allow everything.
        setEntry(projectId, { disabled: new Set(), expiresAt: now() + ERROR_TTL_MS });
        logger.warn(
          {
            scope: "ingest.source_filter",
            projectId,
            err: err instanceof Error ? err.message : String(err),
          },
          "ingest source-filter refresh failed; allowing ingest (fail-open)",
        );
      } finally {
        inflight.delete(projectId);
      }
    })();
  }

  return {
    allows(projectId, source, signal) {
      const entry = cache.get(projectId);
      if (!entry || entry.expiresAt <= now()) {
        refresh(projectId); // async; never awaited on the hot path
      }
      // Use the last-known set (so a disabled source stays disabled across the
      // refresh), defaulting to allow when we've never resolved it.
      if (!entry) return true;
      return !entry.disabled.has(ingestFilterKey(source, signal));
    },
  };
}
