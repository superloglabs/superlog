import type { ClickHouseClient } from "@clickhouse/client";
import { metrics } from "@opentelemetry/api";
import type { DB } from "@superlog/db";
import { sql } from "drizzle-orm";

type LoggerLike = {
  error(obj: Record<string, unknown>, msg: string): void;
};

type PostgresRow = {
  active_connections: number | string;
  idle_connections: number | string;
  long_running_transactions: number | string;
  database_size_bytes: number | string;
};

type ClickHouseMetricRow = {
  name: string;
  value: number | string;
};

const meter = metrics.getMeter("@superlog/worker/prod-datastores");

function numeric(value: number | string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function loadPostgresSnapshot(database: Pick<DB, "execute">): Promise<PostgresRow> {
  const rows = await database.execute<PostgresRow>(sql`
    SELECT
      count(*) FILTER (WHERE state = 'active')::int AS active_connections,
      count(*) FILTER (WHERE state = 'idle')::int AS idle_connections,
      count(*) FILTER (
        WHERE xact_start IS NOT NULL
          AND now() - xact_start > interval '5 minutes'
      )::int AS long_running_transactions,
      pg_database_size(current_database())::bigint AS database_size_bytes
    FROM pg_stat_activity
    WHERE datname = current_database()
  `);
  return (
    rows[0] ?? {
      active_connections: 0,
      idle_connections: 0,
      long_running_transactions: 0,
      database_size_bytes: 0,
    }
  );
}

export async function loadClickHouseMetrics(
  clickhouse: Pick<ClickHouseClient, "query">,
): Promise<Map<string, number>> {
  const metricsByName = new Map<string, number>();

  const systemMetrics = await clickhouse.query({
    format: "JSONEachRow",
    query: `
      SELECT 'memory_resident_bytes' AS name, toFloat64(value) AS value
      FROM system.asynchronous_metrics
      WHERE metric = 'MemoryResident'
      UNION ALL
      SELECT 'memory_available_bytes' AS name, toFloat64(value) AS value
      FROM system.asynchronous_metrics
      WHERE metric = 'OSMemoryAvailable'
      UNION ALL
      SELECT 'active_queries' AS name, toFloat64(value) AS value
      FROM system.metrics
      WHERE metric = 'Query'
    `,
  });
  for (const row of await systemMetrics.json<ClickHouseMetricRow>()) {
    metricsByName.set(row.name, numeric(row.value));
  }

  try {
    const queryLog = await clickhouse.query({
      format: "JSONEachRow",
      query: `
        SELECT 'query_duration_p95_ms' AS name, toFloat64(quantile(0.95)(query_duration_ms)) AS value
        FROM system.query_log
        WHERE event_time > now() - INTERVAL 5 MINUTE
          AND type = 'QueryFinish'
      `,
    });
    for (const row of await queryLog.json<ClickHouseMetricRow>()) {
      metricsByName.set(row.name, numeric(row.value));
    }
  } catch {
    // Some ClickHouse profiles disable query_log. Keep emitting system metrics
    // so memory and active-query gauges do not disappear with p95 latency.
  }

  return metricsByName;
}

export function registerDatastoreObservability(opts: {
  db: Pick<DB, "execute">;
  clickhouse: Pick<ClickHouseClient, "query">;
  logger: LoggerLike;
}): void {
  const pgConnections = meter.createObservableGauge("superlog.prod.postgres.connections", {
    description: "Postgres connections in the current database, grouped by state.",
  });
  const pgLongTransactions = meter.createObservableGauge(
    "superlog.prod.postgres.long_running_transactions",
    {
      description: "Postgres transactions open for more than five minutes.",
    },
  );
  const pgDatabaseSize = meter.createObservableGauge("superlog.prod.postgres.database_size_bytes", {
    description: "Current Postgres database size in bytes.",
    unit: "By",
  });
  const clickhouseMemoryResident = meter.createObservableGauge(
    "superlog.prod.clickhouse.memory.resident_bytes",
    {
      description: "ClickHouse resident memory from system.asynchronous_metrics.",
      unit: "By",
    },
  );
  const clickhouseMemoryAvailable = meter.createObservableGauge(
    "superlog.prod.clickhouse.memory.available_bytes",
    {
      description: "ClickHouse available OS memory from system.asynchronous_metrics.",
      unit: "By",
    },
  );
  const clickhouseActiveQueries = meter.createObservableGauge(
    "superlog.prod.clickhouse.queries.active",
    {
      description: "ClickHouse active query count from system.metrics.",
    },
  );
  const clickhouseQueryP95 = meter.createObservableGauge(
    "superlog.prod.clickhouse.query.duration_p95_ms",
    {
      description: "ClickHouse finished query duration p95 over the last five minutes.",
      unit: "ms",
    },
  );

  meter.addBatchObservableCallback(
    async (result) => {
      const [postgres, clickhouse] = await Promise.allSettled([
        loadPostgresSnapshot(opts.db),
        loadClickHouseMetrics(opts.clickhouse),
      ]);

      if (postgres.status === "fulfilled") {
        result.observe(pgConnections, numeric(postgres.value.active_connections), {
          "db.connection.state": "active",
        });
        result.observe(pgConnections, numeric(postgres.value.idle_connections), {
          "db.connection.state": "idle",
        });
        result.observe(pgLongTransactions, numeric(postgres.value.long_running_transactions));
        result.observe(pgDatabaseSize, numeric(postgres.value.database_size_bytes));
      } else {
        opts.logger.error(
          { err: postgres.reason, scope: "prod-datastore-observability", datastore: "postgres" },
          "postgres observability snapshot failed",
        );
      }

      if (clickhouse.status === "fulfilled") {
        result.observe(
          clickhouseMemoryResident,
          clickhouse.value.get("memory_resident_bytes") ?? 0,
        );
        result.observe(
          clickhouseMemoryAvailable,
          clickhouse.value.get("memory_available_bytes") ?? 0,
        );
        result.observe(clickhouseActiveQueries, clickhouse.value.get("active_queries") ?? 0);
        result.observe(clickhouseQueryP95, clickhouse.value.get("query_duration_p95_ms") ?? 0);
      } else {
        opts.logger.error(
          { err: clickhouse.reason, scope: "prod-datastore-observability", datastore: "clickhouse" },
          "clickhouse observability snapshot failed",
        );
      }
    },
    [
      pgConnections,
      pgLongTransactions,
      pgDatabaseSize,
      clickhouseMemoryResident,
      clickhouseMemoryAvailable,
      clickhouseActiveQueries,
      clickhouseQueryP95,
    ],
  );
}
