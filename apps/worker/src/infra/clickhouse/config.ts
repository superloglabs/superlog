import type { createClient } from "@clickhouse/client";

export type ClickHouseConfig = NonNullable<Parameters<typeof createClient>[0]>;

export function getClickhouseConfig(
  env: Record<string, string | undefined> = process.env,
): ClickHouseConfig {
  return {
    url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
    username: env.CLICKHOUSE_USER ?? "default",
    password: env.CLICKHOUSE_PASSWORD ?? "",
    database: env.CLICKHOUSE_DATABASE ?? env.CLICKHOUSE_DB ?? "superlog",
  };
}
