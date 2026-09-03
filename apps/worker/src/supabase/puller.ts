export const SUPABASE_QUERY_METRICS_SQL = `
with ranked_statements as (
  select
    statements.*,
    row_number() over (order by statements.total_exec_time desc) as total_exec_rank,
    row_number() over (order by statements.mean_exec_time desc) as mean_exec_rank
  from extensions.pg_stat_statements as statements
  where statements.toplevel = true
)
select
  statements.queryid::text as queryid,
  statements.query,
  statements.calls::text as calls,
  statements.rows::text as rows,
  statements.total_exec_time,
  statements.total_plan_time,
  statements.mean_exec_time,
  statements.shared_blks_hit::text as shared_blks_hit,
  statements.shared_blks_read::text as shared_blks_read,
  statements.temp_blks_read::text as temp_blks_read,
  statements.temp_blks_written::text as temp_blks_written,
  databases.datname,
  roles.rolname,
  info.stats_reset
from ranked_statements as statements
inner join pg_catalog.pg_database as databases on databases.oid = statements.dbid
inner join pg_catalog.pg_roles as roles on roles.oid = statements.userid
cross join extensions.pg_stat_statements_info as info
where statements.total_exec_rank <= 50 or statements.mean_exec_rank <= 50
order by least(statements.total_exec_rank, statements.mean_exec_rank)
limit 100`.trim();

export type SupabaseQueryMetricsRow = {
  queryid: string;
  query: string;
  calls: string;
  rows: string;
  total_exec_time: number;
  total_plan_time: number;
  mean_exec_time: number;
  shared_blks_hit: string;
  shared_blks_read: string;
  temp_blks_read: string;
  temp_blks_written: string;
  datname: string;
  rolname: string;
  stats_reset: string;
};

export type SupabasePullConnection = {
  id: string;
  projectRef: string;
  projectName: string;
  organizationSlug: string;
  region: string;
  environment: string;
  ingestKey: string | null;
};

export type SupabasePullGrant = {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  connections: SupabasePullConnection[];
};

export type SupabasePullerStore = {
  listActiveGrants(): Promise<SupabasePullGrant[]>;
  saveGrantTokens(
    grantId: string,
    token: { accessToken: string; refreshToken: string | null; tokenExpiresAt: Date },
  ): Promise<void>;
  markConnectionSuccess(
    connectionId: string,
    polledAt: Date,
    receivedMetrics: boolean,
  ): Promise<void>;
  markConnectionFailure(connectionId: string, error: string, polledAt: Date): Promise<void>;
};

export type SupabaseMetricsReader = {
  refreshAccessToken(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresInSeconds: number;
  }>;
  runReadOnlyQuery(
    projectRef: string,
    sql: string,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<SupabaseQueryMetricsRow[]>;
};

export async function runSupabasePullOnce(input: {
  store: SupabasePullerStore;
  reader: SupabaseMetricsReader;
  forward(input: {
    payload: ReturnType<typeof pgStatStatementsToOtlp>;
    ingestKey: string;
    signal?: AbortSignal;
  }): Promise<boolean>;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<{ grants: number; connections: number; statements: number; errors: number }> {
  const now = input.now ?? (() => new Date());
  const stats = { grants: 0, connections: 0, statements: 0, errors: 0 };

  for (const grant of await input.store.listActiveGrants()) {
    input.signal?.throwIfAborted();
    stats.grants += 1;
    let accessToken = grant.accessToken;
    try {
      if (tokenNeedsRefresh(grant.tokenExpiresAt, now())) {
        if (!grant.refreshToken) throw new Error("Supabase OAuth grant needs reconnecting");
        const refreshed = await input.reader.refreshAccessToken(grant.refreshToken, input.signal);
        accessToken = refreshed.accessToken;
        await input.store.saveGrantTokens(grant.id, {
          accessToken,
          refreshToken: refreshed.refreshToken ?? grant.refreshToken,
          tokenExpiresAt: new Date(now().getTime() + refreshed.expiresInSeconds * 1000),
        });
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      const message = errorMessage(error);
      for (const connection of grant.connections) {
        stats.connections += 1;
        stats.errors += 1;
        await input.store.markConnectionFailure(connection.id, message, now());
      }
      continue;
    }

    for (const connection of grant.connections) {
      input.signal?.throwIfAborted();
      stats.connections += 1;
      const polledAt = now();
      try {
        if (!connection.ingestKey) throw new Error("Supabase metrics ingest key is unavailable");
        const rows = await input.reader.runReadOnlyQuery(
          connection.projectRef,
          SUPABASE_QUERY_METRICS_SQL,
          accessToken,
          input.signal,
        );
        const delivered = await input.forward({
          payload: pgStatStatementsToOtlp(rows, connection, polledAt),
          ingestKey: connection.ingestKey,
          signal: input.signal,
        });
        if (!delivered) throw new Error("Supabase metrics intake rejected the payload");
        stats.statements += rows.length;
        await input.store.markConnectionSuccess(connection.id, polledAt, rows.length > 0);
      } catch (error) {
        input.signal?.throwIfAborted();
        stats.errors += 1;
        await input.store.markConnectionFailure(connection.id, errorMessage(error), polledAt);
      }
    }
  }
  return stats;
}

export function pgStatStatementsToOtlp(
  rows: SupabaseQueryMetricsRow[],
  connection: Pick<
    SupabasePullConnection,
    "projectRef" | "projectName" | "organizationSlug" | "region" | "environment"
  >,
  observedAt: Date,
) {
  const metrics = [
    integerSum("postgresql.query.calls", "{call}", rows, (row) => row.calls),
    doubleSum(
      "postgresql.query.execution.time",
      "s",
      rows,
      (row) => (number(row.total_exec_time) + number(row.total_plan_time)) / 1000,
    ),
    integerSum("postgresql.query.rows", "{row}", rows, (row) => row.rows),
    integerSum("postgresql.query.shared_blocks.hit", "{block}", rows, (row) => row.shared_blks_hit),
    integerSum(
      "postgresql.query.shared_blocks.read",
      "{block}",
      rows,
      (row) => row.shared_blks_read,
    ),
    integerSum("postgresql.query.temp_blocks.read", "{block}", rows, (row) => row.temp_blks_read),
    integerSum(
      "postgresql.query.temp_blocks.written",
      "{block}",
      rows,
      (row) => row.temp_blks_written,
    ),
  ];
  const timestamp = unixNanos(observedAt);
  for (const metric of metrics) {
    for (const point of metric.sum.dataPoints) point.timeUnixNano = timestamp;
  }

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: Object.entries({
            "service.name": "supabase-postgres",
            "service.instance.id": connection.projectRef,
            "deployment.environment.name": connection.environment,
            "telemetry.source": "supabase",
            "supabase.project.ref": connection.projectRef,
            "supabase.project.name": connection.projectName,
            "supabase.organization.slug": connection.organizationSlug,
            "cloud.region": connection.region,
          }).map(([key, value]) => ({ key, value: { stringValue: value } })),
        },
        scopeMetrics: [{ scope: { name: "superlog.supabase.pg_stat_statements" }, metrics }],
      },
    ],
  };
}

function integerSum(
  name: string,
  unit: string,
  rows: SupabaseQueryMetricsRow[],
  value: (row: SupabaseQueryMetricsRow) => string,
) {
  return {
    name,
    unit,
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: rows.map((row) => ({
        attributes: statementAttributes(row),
        startTimeUnixNano: startTime(row),
        asInt: integer(value(row)),
        timeUnixNano: "",
      })),
    },
  };
}

function doubleSum(
  name: string,
  unit: string,
  rows: SupabaseQueryMetricsRow[],
  value: (row: SupabaseQueryMetricsRow) => number,
) {
  return {
    name,
    unit,
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: rows.map((row) => ({
        attributes: statementAttributes(row),
        startTimeUnixNano: startTime(row),
        asDouble: value(row),
        timeUnixNano: "",
      })),
    },
  };
}

function statementAttributes(row: SupabaseQueryMetricsRow) {
  return Object.entries({
    "db.system.name": "postgresql",
    "db.namespace": row.datname,
    "db.query.text": row.query,
    "postgresql.query.id": row.queryid,
    "postgresql.role.name": row.rolname,
  }).map(([key, value]) => ({ key, value: { stringValue: value } }));
}

function tokenNeedsRefresh(expiresAt: Date | null, now: Date): boolean {
  return !expiresAt || expiresAt.getTime() <= now.getTime() + 5 * 60 * 1000;
}

function startTime(row: SupabaseQueryMetricsRow): string {
  const date = new Date(row.stats_reset);
  return unixNanos(Number.isFinite(date.getTime()) ? date : new Date(0));
}

function unixNanos(date: Date): string {
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

function integer(value: string): string {
  return /^\d+$/.test(value) ? value : "0";
}

function number(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
