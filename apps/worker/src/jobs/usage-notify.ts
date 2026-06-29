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
import { usageNotifier } from "../billing/usage-notifier-infra.js";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

// Look back further than the 5-min schedule so a slow/missed run can't drop an
// org; the notifier dedupes, so overlap is harmless.
const LOOKBACK = "10 MINUTE";
const METRIC_TABLES = [
  "otel_metrics_sum",
  "otel_metrics_gauge",
  "otel_metrics_histogram",
  "otel_metrics_summary",
  "otel_metrics_exp_histogram",
];

async function activeProjectIds(clickhouse: JobDeps["clickhouse"]): Promise<string[]> {
  const traceLog = ["otel_traces", "otel_logs"].map(
    (t) =>
      `SELECT ResourceAttributes['superlog.project_id'] AS pid FROM ${t} WHERE Timestamp > now() - INTERVAL ${LOOKBACK} AND pid != ''`,
  );
  const metrics = METRIC_TABLES.map(
    (t) =>
      `SELECT ResourceAttributes['superlog.project_id'] AS pid FROM ${t} WHERE TimeUnix > now() - INTERVAL ${LOOKBACK} AND pid != ''`,
  );
  const query = `SELECT DISTINCT pid FROM (${[...traceLog, ...metrics].join(" UNION DISTINCT ")})`;
  const result = await clickhouse.query({ query, format: "JSONEachRow" });
  const rows = (await result.json()) as Array<{ pid: string }>;
  return rows.map((r) => r.pid).filter(Boolean);
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
      const orgs = await db
        .selectDistinct({ orgId: schema.projects.orgId })
        .from(schema.projects)
        .where(inArray(schema.projects.id, projectIds));
      for (const { orgId } of orgs) await notifier.notify(orgId);
      logger.info(
        { scope: "jobs.usage-notify", orgs: orgs.length },
        "evaluated active orgs for usage notifications",
      );
    };
  },
};
