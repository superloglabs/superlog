// One resolver for every worker ClickHouse client. The ingest loop, the
// trace-context reader, and autorecovery all have to read the same database;
// when they drifted, recovery inspected a store the worker never wrote and
// every candidate read failed (issue #286).
//
// CLICKHOUSE_DB is the documented name (apps/worker/.env.example and
// scripts/portless-stack.sh). CLICKHOUSE_DATABASE remains accepted because
// managed deployments set it, but it no longer changes the answer for only one
// consumer: both names resolve identically everywhere.
export type ClickHouseConfig = {
  url: string;
  username: string;
  password: string;
  database: string;
};

export const CLICKHOUSE_DB_FALLBACK = "superlog";

export function resolveClickhouseConfig(env: NodeJS.ProcessEnv): ClickHouseConfig {
  return {
    url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
    username: env.CLICKHOUSE_USER ?? "default",
    password: env.CLICKHOUSE_PASSWORD ?? "",
    database: env.CLICKHOUSE_DB ?? env.CLICKHOUSE_DATABASE ?? CLICKHOUSE_DB_FALLBACK,
  };
}
