import type { ClickHouseClient } from "@clickhouse/client";
// Scheduled job: fire usage-limit notifications for recently-active orgs, out of
// band from the worker tick loop. Each run derives the candidate set itself by
// asking ClickHouse which projects produced telemetry in the last window, maps
// them to orgs, and evaluates each via the notifier (which dedupes + fires any
// newly-crossed 50/85/100% step). Deriving the set from ClickHouse keeps the job
// stateless and correct across worker instances — no process-local queue.
//
// Opts out (returns null → not scheduled) when usage notifications are off
// (USAGE_NOTIFICATIONS_ENABLED / AUTUMN_SECRET_KEY unset).
import { schema } from "@superlog/db";
import { inArray } from "drizzle-orm";
import {
  METRIC_TABLES,
  METRIC_USAGE_PROJECT_ID_COLUMN,
  findMetricUsageProjectionTables,
} from "../billing/metric-usage-schema.js";
import { usageNotifier } from "../billing/usage-notifier-infra.js";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

// Look back well past the 5-min schedule so a delayed run or ingestion lag can't
// drop an org; the notifier dedupes per period, so generous overlap is harmless.
const LOOKBACK = "30 MINUTE";
// project_id comes from client-controlled telemetry resource attributes — filter
// to well-formed UUIDs so one malformed value can't fail the whole orgs lookup.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bound the per-query IN list under high project cardinality.
const ID_CHUNK = 500;
type QueryClient = Pick<ClickHouseClient, "query">;

async function queryProjectIds(clickhouse: QueryClient, query: string): Promise<string[]> {
  const result = await clickhouse.query({ query, format: "JSONEachRow" });
  const rows = (await result.json()) as Array<{ pid: string }>;
  return rows.map(({ pid }) => pid);
}

async function eventsRollupAvailable(clickhouse: QueryClient): Promise<boolean> {
  try {
    const result = await clickhouse.query({
      query: "EXISTS TABLE events_per_minute",
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{ result: number | string }>;
    return Number(rows[0]?.result) === 1;
  } catch {
    return false;
  }
}

export async function activeProjectIds(clickhouse: QueryClient): Promise<string[]> {
  const projectIds = new Set<string>();
  const add = (ids: string[]) => {
    for (const id of ids) if (UUID_RE.test(id)) projectIds.add(id);
  };

  if (await eventsRollupAvailable(clickhouse)) {
    add(
      await queryProjectIds(
        clickhouse,
        `SELECT DISTINCT project_id AS pid
         FROM events_per_minute
         PREWHERE minute > now() - INTERVAL ${LOOKBACK} AND minute <= now()
         WHERE project_id != ''`,
      ),
    );
  } else {
    add(
      await queryProjectIds(
        clickhouse,
        `SELECT DISTINCT ResourceAttributes['superlog.project_id'] AS pid
         FROM otel_traces
         PREWHERE Timestamp > now64(9) - INTERVAL ${LOOKBACK} AND Timestamp <= now64(9)
         WHERE pid != ''`,
      ),
    );
    add(
      await queryProjectIds(
        clickhouse,
        `SELECT DISTINCT ResourceAttributes['superlog.project_id'] AS pid
         FROM otel_logs
         PREWHERE TimestampTime > now() - INTERVAL ${LOOKBACK} - INTERVAL 1 SECOND
           AND TimestampTime <= now()
         WHERE Timestamp > now64(9) - INTERVAL ${LOOKBACK}
           AND Timestamp <= now64(9) AND pid != ''`,
      ),
    );
  }

  const optimizedTables = await findMetricUsageProjectionTables(clickhouse);
  for (const table of METRIC_TABLES) {
    const projectId = optimizedTables.has(table)
      ? METRIC_USAGE_PROJECT_ID_COLUMN
      : "ResourceAttributes['superlog.project_id']";
    add(
      await queryProjectIds(
        clickhouse,
        `SELECT DISTINCT ${projectId} AS pid
         FROM ${table}
         PREWHERE TimeUnix > now64(9) - INTERVAL ${LOOKBACK} AND TimeUnix <= now64(9)
         WHERE ${projectId} != ''`,
      ),
    );
  }

  return [...projectIds];
}

export const job: JobDefinition = {
  name: "usage-notify",
  schedule: "*/5 * * * *",
  create: ({ db, clickhouse }: JobDeps) => {
    const notifier = usageNotifier;
    if (!notifier) return null;
    return async () => {
      const projectIds = await activeProjectIds(clickhouse);
      if (projectIds.length === 0) return;
      // Resolve active projects → distinct orgs in bounded chunks so a large
      // active-project set can't blow up a single IN list.
      const orgIds = new Set<string>();
      for (let i = 0; i < projectIds.length; i += ID_CHUNK) {
        const rows = await db
          .selectDistinct({ orgId: schema.projects.orgId })
          .from(schema.projects)
          .where(inArray(schema.projects.id, projectIds.slice(i, i + ID_CHUNK)));
        for (const { orgId } of rows) orgIds.add(orgId);
      }
      for (const orgId of orgIds) await notifier.notify(orgId);
      logger.info(
        { scope: "jobs.usage-notify", orgs: orgIds.size },
        "evaluated active orgs for usage notifications",
      );
    };
  },
};
