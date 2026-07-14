// Infrastructure for telemetry usage metering: ClickHouse count queries, the
// Postgres project→org lookup + cursor store, the Autumn track() call, and the
// interval-gated ticker for createWorkerTick. Pure orchestration lives in
// usage-metering.ts.
import type { ClickHouseClient } from "@clickhouse/client";
import { type DB, db as defaultDb, schema } from "@superlog/db";
import { inArray } from "drizzle-orm";
import { findMetricUsageProjectionTables } from "./metric-usage-schema.js";
import { buildUsageCountQueries } from "./usage-count-query.js";
import {
  type UsageMeterDeps,
  type UsageSignal,
  meterTelemetryUsageTick,
} from "./usage-metering.js";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;

// ClickHouse DateTime64 params want "YYYY-MM-DD hh:mm:ss.fffffffff" (UTC, no Z).
function chTime(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

export function createCountByProject(clickhouse: Pick<ClickHouseClient, "query">) {
  let optimizedMetricTables: Promise<ReadonlySet<string>> | undefined;
  return async (signal: UsageSignal, afterIso: string, untilIso: string) => {
    const out = new Map<string, number>();
    // Metrics live in five physical tables. Query them one at a time so a
    // single metering pass never fans five full-partition scans out in
    // parallel under write load. Each request also gets its own client
    // deadline instead of sharing one deadline across a UNION ALL query.
    let optimizedTables: ReadonlySet<string> | undefined;
    if (signal === "metric_points") {
      if (!optimizedMetricTables) {
        optimizedMetricTables = findMetricUsageProjectionTables(clickhouse);
      }
      optimizedTables = await optimizedMetricTables;
    }
    for (const query of buildUsageCountQueries(signal, optimizedTables)) {
      const result = await clickhouse.query({
        query,
        query_params: { after: chTime(afterIso), until: chTime(untilIso) },
        format: "JSONEachRow",
      });
      const rows = (await result.json()) as Array<{ pid: string; c: number | string }>;
      for (const row of rows) {
        const n = Number(row.c);
        if (row.pid && Number.isFinite(n) && n > 0) {
          out.set(row.pid, (out.get(row.pid) ?? 0) + n);
        }
      }
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

// Attempt to create an Autumn customer for the given org so that a subsequent
// track() call can succeed. Autumn auto-enables the Free plan on customer
// creation (autoEnable:true in autumn.config.ts), so this is sufficient to
// unblock metering. Throws if the creation request itself fails.
async function createAutumnCustomer(
  secretKey: string,
  orgId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl("https://api.useautumn.com/v1/customers", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: orgId }),
    signal: AbortSignal.timeout(TRACK_TIMEOUT_MS),
  });
  // 200 = created; 409 = already exists (race with another tick or auth plugin).
  // Both are safe to treat as success — the customer exists either way.
  if (!res.ok && res.status !== 409) throw new Error(`autumn /customers -> ${res.status}`);
}

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
    if (res.status === 404) {
      // The org is not yet provisioned in Autumn (e.g. a legacy org created
      // before the Autumn integration, or a sign-up that bypassed the auth
      // plugin). Auto-create the customer — Autumn attaches the Free plan via
      // autoEnable — then retry the track so usage is not dropped.
      await createAutumnCustomer(secretKey, orgId, fetchImpl);
      const retry = await fetchImpl("https://api.useautumn.com/v1/track", {
        method: "POST",
        headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: orgId, feature_id: featureId, value }),
        signal: AbortSignal.timeout(TRACK_TIMEOUT_MS),
      });
      if (!retry.ok) throw new Error(`autumn /track -> ${retry.status} (after customer create)`);
      return;
    }
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
