// Infrastructure for telemetry usage metering: ClickHouse count queries, the
// Postgres project→org lookup + cursor store, the Autumn track() call, and the
// interval-gated ticker for createWorkerTick. Pure orchestration lives in
// usage-metering.ts.
import { type ClickHouseClient } from "@clickhouse/client";
import { type DB, db as defaultDb, schema } from "@superlog/db";
import { inArray } from "drizzle-orm";
import {
  type UsageMeterDeps,
  type UsageSignal,
  meterTelemetryUsageTick,
} from "./usage-metering.js";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;

// One bounded-window count query per signal. Metrics span five OTel tables.
function countQuery(signal: UsageSignal): string {
  if (signal === "spans") {
    return `SELECT ResourceAttributes['superlog.project_id'] AS pid, count() AS c
            FROM otel_traces
            WHERE Timestamp > {after:DateTime64(9)} AND Timestamp <= {until:DateTime64(9)} AND pid != ''
            GROUP BY pid`;
  }
  if (signal === "logs") {
    return `SELECT ResourceAttributes['superlog.project_id'] AS pid, count() AS c
            FROM otel_logs
            WHERE Timestamp > {after:DateTime64(9)} AND Timestamp <= {until:DateTime64(9)} AND pid != ''
            GROUP BY pid`;
  }
  const metricTables = [
    "otel_metrics_sum",
    "otel_metrics_gauge",
    "otel_metrics_histogram",
    "otel_metrics_summary",
    "otel_metrics_exp_histogram",
  ];
  const union = metricTables
    .map(
      (t) =>
        `SELECT ResourceAttributes['superlog.project_id'] AS pid, count() AS c FROM ${t}
         WHERE TimeUnix > {after:DateTime64(9)} AND TimeUnix <= {until:DateTime64(9)} AND pid != '' GROUP BY pid`,
    )
    .join(" UNION ALL ");
  return `SELECT pid, sum(c) AS c FROM (${union}) GROUP BY pid`;
}

// ClickHouse DateTime64 params want "YYYY-MM-DD hh:mm:ss.fffffffff" (UTC, no Z).
function chTime(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

function createCountByProject(clickhouse: Pick<ClickHouseClient, "query">) {
  return async (signal: UsageSignal, afterIso: string, untilIso: string) => {
    const result = await clickhouse.query({
      query: countQuery(signal),
      query_params: { after: chTime(afterIso), until: chTime(untilIso) },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{ pid: string; c: number | string }>;
    const out = new Map<string, number>();
    for (const row of rows) {
      const n = Number(row.c);
      if (row.pid && Number.isFinite(n) && n > 0) out.set(row.pid, n);
    }
    return out;
  };
}

function createResolveOrgIds(database: DB) {
  return async (projectIds: string[]) => {
    const unique = [...new Set(projectIds)];
    if (unique.length === 0) return new Map<string, string>();
    const rows = await database
      .select({ id: schema.projects.id, orgId: schema.projects.orgId })
      .from(schema.projects)
      .where(inArray(schema.projects.id, unique));
    return new Map(rows.map((r) => [r.id, r.orgId]));
  };
}

function createCursorStore(database: DB, windowMs: number) {
  const zero = () => new Date(Date.now() - windowMs); // first run scans the last window
  return {
    getCursor: async (name: string): Promise<Date> => {
      const row = await database.query.workerState.findFirst({
        where: (ws, { eq }) => eq(ws.name, name),
      });
      return row ? row.cursor : zero();
    },
    setCursor: async (name: string, at: Date): Promise<void> => {
      await database
        .insert(schema.workerState)
        .values({ name, cursor: at, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.workerState.name,
          set: { cursor: at, updatedAt: new Date() },
        });
    },
  };
}

const TRACK_TIMEOUT_MS = 10_000;

function createAutumnTrack(secretKey: string, fetchImpl: typeof fetch = fetch) {
  return async (orgId: string, featureId: string, value: number): Promise<void> => {
    // Bound the request so a hung Autumn connection can't stall the worker tick
    // loop indefinitely. On timeout the fetch rejects → the caller logs + skips
    // (cursor already advanced), same as any other track failure.
    const res = await fetchImpl("https://api.useautumn.com/v1/track", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: orgId, feature_id: featureId, value }),
      signal: AbortSignal.timeout(TRACK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`autumn /track -> ${res.status}`);
  };
}

export type UsageMeterTicker = () => Promise<number>;

// Interval-gated ticker for createWorkerTick. Returns null when billing is
// unconfigured (no AUTUMN_SECRET_KEY) — no point scanning ClickHouse if there's
// nowhere to report usage.
export function createUsageMeterTicker(options: {
  clickhouse: Pick<ClickHouseClient, "query">;
  db?: DB;
  secretKey?: string | null;
  intervalMs?: number;
  windowMs?: number;
  now?: () => number;
}): UsageMeterTicker | null {
  const secretKey = (options.secretKey ?? process.env.AUTUMN_SECRET_KEY)?.trim();
  if (!secretKey) return null;

  const database = options.db ?? defaultDb;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const nowMs = options.now ?? Date.now;
  const cursors = createCursorStore(database, windowMs);
  const deps: UsageMeterDeps = {
    countByProject: createCountByProject(options.clickhouse),
    resolveOrgIds: createResolveOrgIds(database),
    track: createAutumnTrack(secretKey),
    getCursor: cursors.getCursor,
    setCursor: cursors.setCursor,
    now: () => new Date(nowMs()),
    windowMs,
  };

  let nextRunAt = 0;
  let running = false;
  return async () => {
    const current = nowMs();
    if (running || current < nextRunAt) return 0;
    running = true;
    nextRunAt = current + intervalMs;
    try {
      return await meterTelemetryUsageTick(deps);
    } finally {
      running = false;
    }
  };
}
