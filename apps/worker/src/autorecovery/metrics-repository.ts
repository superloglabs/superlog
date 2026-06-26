import type { ClickHouseClient } from "@clickhouse/client";
import type { CandidateIncident } from "./domain.js";

export type ActivityBucket = { hour: string; count: number };

export type IncidentActivity = {
  totalEvents: number;
  perHour: ActivityBucket[];
  lookbackHours: number;
};

export type ServiceTraffic = {
  totalSpans: number;
  perHour: ActivityBucket[];
  lookbackHours: number;
  service: string | null;
};

export type AutorecoveryMetricsRepository = ReturnType<typeof createAutorecoveryMetricsRepository>;

export function createAutorecoveryMetricsRepository(getCh: () => Promise<ClickHouseClient>) {
  return {
    // Counts exception events on the incident's service whose `exception.type`
    // matches one of the live issues linked to the incident. Filtering by
    // exception.type is a strict superset of the actual incident events (an
    // unrelated issue with the same type would also match), but it cuts out
    // the dominant noise mode: a project-wide error storm on a different
    // exception type being misattributed to this incident. See incident
    // 779a80aa (2026-05-22) where the un-scoped query counted 90k/hr of
    // ECONNREFUSED storms against an "Invitation not found" issue that had
    // fired twice.
    //
    // Ideal long-term filter would re-compute the fingerprint per event in
    // CH; that's expensive without the JS-side bucketing logic. Adding
    // exception.message into the filter could narrow further but risks
    // undercounting since `issues.message` only stores the latest sample.
    async queryIncidentActivity(
      incident: CandidateIncident,
      hours: number,
    ): Promise<IncidentActivity> {
      const exceptionTypes = Array.from(
        new Set(incident.issueSignatures.map((s) => s.exceptionType)),
      );
      // No live signatures means we have nothing to scope the query to —
      // return zero and let the agent treat it as no signal. Counting the
      // whole service here would be the original bug.
      if (exceptionTypes.length === 0) {
        return { totalEvents: 0, perHour: [], lookbackHours: hours };
      }
      const ch = await getCh();
      // Reads the exception-only projection (otel_exceptions) instead of
      // ARRAY JOIN Events over otel_traces — same trace-exception counts, but a
      // small indexed table rather than a full multi-day scan of every span's
      // events. kind = 'span' preserves the original otel_traces-only scope.
      const result = await ch.query({
        query: `
          SELECT
            toString(toStartOfHour(Timestamp)) AS hour,
            toUInt64(count()) AS count
          FROM otel_exceptions
          WHERE project_id = {project_id:String}
            AND kind = 'span'
            AND exception_type IN {exception_types:Array(String)}
            AND Timestamp >= now() - INTERVAL {hours:UInt32} HOUR
            ${incident.service ? "AND service = {service:String}" : ""}
          GROUP BY hour
          ORDER BY hour ASC
        `,
        query_params: {
          project_id: incident.projectId,
          service: incident.service ?? "",
          exception_types: exceptionTypes,
          hours,
        },
        format: "JSONEachRow",
      });
      const rows = (await result.json()) as ActivityBucket[];
      const totalEvents = rows.reduce((acc, r) => acc + Number(r.count), 0);
      return { totalEvents, perHour: rows, lookbackHours: hours };
    },

    async queryServiceTraffic(
      incident: CandidateIncident,
      hours: number,
    ): Promise<ServiceTraffic> {
      if (!incident.service) {
        return { totalSpans: 0, perHour: [], lookbackHours: hours, service: null };
      }
      const ch = await getCh();
      // Prefer the events_per_minute rollup. A service's total span count by
      // hour is exactly sum(c) over the (project, signal='traces', service)
      // cells. The raw otel_traces scan instead reads every span in the window:
      // for a high-volume service over a multi-day lookback that is 100M+ rows
      // (~100s per query), and the autorecovery agent fires this tool for many
      // candidates per tick. Those scans saturated the ClickHouse read pool,
      // which timed out the rest of the worker's sequential tick — including
      // the agent-run queue, leaving investigations stuck in 'queued'. The
      // rollup answers the same count from ~10k pre-aggregated rows in
      // milliseconds. Fall back to the raw scan only where the rollup isn't
      // deployed (it is not part of the collector's auto-created schema — see
      // infra/clickhouse/migrations/003_events_per_minute.sql).
      if (await rollupAvailable(ch)) {
        const result = await ch.query({
          query: `
            SELECT
              toString(toStartOfHour(minute)) AS hour,
              toUInt64(sum(c)) AS count
            FROM events_per_minute
            WHERE project_id = {project_id:String}
              AND signal = 'traces'
              AND service = {service:String}
              -- Round the lower bound down to the rollup's minute granularity
              -- (the finest it stores) to mirror the raw path's exact
              -- now() - INTERVAL hours HOUR bound. Rounding to the hour instead
              -- would pull up to ~59 extra minutes into the earliest bucket and
              -- inflate the traffic signal. Matches the API read path
              -- (countSeriesFromRollup in apps/api/src/mcp/clickhouse.ts).
              AND minute >= toStartOfMinute(now() - INTERVAL {hours:UInt32} HOUR)
            GROUP BY hour
            ORDER BY hour ASC
          `,
          query_params: {
            project_id: incident.projectId,
            service: incident.service,
            hours,
          },
          format: "JSONEachRow",
        });
        const rows = (await result.json()) as ActivityBucket[];
        const totalSpans = rows.reduce((acc, r) => acc + Number(r.count), 0);
        return { totalSpans, perHour: rows, lookbackHours: hours, service: incident.service };
      }
      const result = await ch.query({
        query: `
          SELECT
            toString(toStartOfHour(Timestamp)) AS hour,
            toUInt64(count()) AS count
          FROM otel_traces
          WHERE ResourceAttributes['superlog.project_id'] = {project_id:String}
            AND ServiceName = {service:String}
            AND Timestamp >= now() - INTERVAL {hours:UInt32} HOUR
          GROUP BY hour
          ORDER BY hour ASC
        `,
        query_params: {
          project_id: incident.projectId,
          service: incident.service,
          hours,
        },
        format: "JSONEachRow",
      });
      const rows = (await result.json()) as ActivityBucket[];
      const totalSpans = rows.reduce((acc, r) => acc + Number(r.count), 0);
      return { totalSpans, perHour: rows, lookbackHours: hours, service: incident.service };
    },
  };
}

// Probe whether the events_per_minute rollup exists, memoized per client so the
// common (rollup-present) path costs one EXISTS check per process. Mirrors the
// API read path (apps/api/src/mcp/clickhouse.ts). A failed probe drops the memo
// and reports absent, so a transient ClickHouse blip falls back to the raw scan
// for that call without pinning the slow path until restart.
const rollupAvailability = new WeakMap<ClickHouseClient, Promise<boolean>>();

function rollupAvailable(ch: ClickHouseClient): Promise<boolean> {
  let probe = rollupAvailability.get(ch);
  if (!probe) {
    probe = (async () => {
      try {
        const r = await ch.query({
          query: "EXISTS TABLE events_per_minute",
          format: "JSONEachRow",
        });
        const rows = (await r.json()) as { result: number | string }[];
        return Number(rows[0]?.result) === 1;
      } catch {
        rollupAvailability.delete(ch);
        return false;
      }
    })();
    rollupAvailability.set(ch, probe);
  }
  return probe;
}

let cachedClient: ClickHouseClient | null = null;

// Default ClickHouse provider — lazy-initialised, shared across calls.
// Module-level cache is OK here because credentials only come from env
// and never change at runtime. Callers that need a different config
// (tests, alt-region readers) should construct their own and pass it in.
export async function defaultClickhouseClient(): Promise<ClickHouseClient> {
  if (cachedClient) return cachedClient;
  const { createClient } = await import("@clickhouse/client");
  cachedClient = createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    username: process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    // Local portless stacks ship a `superlog` database; prod uses `olly`.
    // `CLICKHOUSE_DB` is the env name `scripts/portless-stack.sh` writes.
    database:
      process.env.CLICKHOUSE_DATABASE ?? process.env.CLICKHOUSE_DB ?? "olly",
  });
  return cachedClient;
}
