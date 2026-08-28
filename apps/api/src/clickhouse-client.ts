import { type ClickHouseClientConfigOptions, createClient } from "@clickhouse/client";

export function clickHouseClientConfig(env: NodeJS.ProcessEnv): ClickHouseClientConfigOptions {
  return {
    url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
    database: env.CLICKHOUSE_DB ?? "superlog",
    username: env.CLICKHOUSE_USER ?? "default",
    password: env.CLICKHOUSE_PASSWORD ?? "",
    // Give heavy filtered queries room to finish. Stale pooled sockets are
    // removed both by timer and immediately before reuse so an event-loop
    // delay cannot race ClickHouse's keep-alive timeout.
    request_timeout: 20_000,
    keep_alive: {
      enabled: true,
      idle_socket_ttl: 2_500,
      eagerly_destroy_stale_sockets: true,
    },
    clickhouse_settings: {
      // Cancel abandoned SELECTs instead of letting them occupy a server slot.
      cancel_http_readonly_queries_on_client_close: 1,
    },
  };
}

export function createApiClickHouseClient(env: NodeJS.ProcessEnv = process.env) {
  return createClient(clickHouseClientConfig(env));
}
