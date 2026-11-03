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

/**
 * Dedicated ClickHouse client for MCP telemetry queries (query_logs,
 * query_traces, query_metrics, list_services). MCP queries may cover wide time
 * ranges chosen by an AI agent and are wrapped by executeRecoverableTelemetryQuery,
 * which turns remaining timeouts into retry_required guidance. Use aligned
 * 90 s client / 85 s server deadlines so the server cancels the query before
 * the HTTP client gives up — the same approach used for managed session queries.
 */
export function createMcpClickHouseClient(env: NodeJS.ProcessEnv = process.env) {
  return createClient({
    ...clickHouseClientConfig(env),
    request_timeout: 90_000,
    clickhouse_settings: {
      cancel_http_readonly_queries_on_client_close: 1,
      max_execution_time: 85,
    },
  });
}
