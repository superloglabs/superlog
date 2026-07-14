import type { ClickHouseClient } from "@clickhouse/client";

// OpenTelemetry's ClickHouse exporter stores metric kinds separately. The HA
// schema adds the same exact-count usage projection to each physical table.
export const METRIC_TABLES = [
  "otel_metrics_sum",
  "otel_metrics_gauge",
  "otel_metrics_histogram",
  "otel_metrics_summary",
  "otel_metrics_exp_histogram",
] as const;

export const METRIC_USAGE_PROJECT_ID_COLUMN = "SuperlogProjectId";

// The optimized column is intentionally optional: collector-created schemas
// and installations that have not applied the projection migration still use
// the ResourceAttributes expression. Return tables individually so a partially
// applied migration remains correct while it finishes.
export async function findMetricUsageProjectionTables(
  clickhouse: Pick<ClickHouseClient, "query">,
): Promise<ReadonlySet<string>> {
  try {
    const result = await clickhouse.query({
      query: `SELECT table
              FROM system.columns
              WHERE database = currentDatabase()
                AND name = {column:String}
                AND table IN ({tables:Array(String)})`,
      query_params: {
        column: METRIC_USAGE_PROJECT_ID_COLUMN,
        tables: [...METRIC_TABLES],
      },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{ table: string }>;
    return new Set(rows.map(({ table }) => table));
  } catch {
    return new Set();
  }
}
