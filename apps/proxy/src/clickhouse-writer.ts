import { createClient, type ClickHouseClient } from "@clickhouse/client";

import type { OtelLogRow, OtelTraceRow } from "./otlp-clickhouse.js";

// Direct-to-ClickHouse ingest writer. Each consumer worker maps an OTLP payload to
// rows and INSERTs them synchronously with insert_quorum, so the SQS message is only
// deleted once the write is durably committed (the consume loop deletes on success,
// leaves on throw). This replaces forwarding through the collector, whose synchronous
// exporter serializes to ~one insert per task — the global ingest ceiling.
//
// Durability note: quorum is preserved (default 2), and async_insert stays OFF, so a
// successful insert means the rows are committed to a quorum of replicas before we ack.

export type IngestClickHouseConfig = {
  url: string;
  database: string;
  username: string;
  password: string;
  insertQuorum: number;
  insertQuorumTimeoutMs: number;
  requestTimeoutMs: number;
};

function readPositiveInt(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Returns null unless INGEST_CLICKHOUSE_DIRECT=true and a ClickHouse URL is set, so
// the consumer keeps forwarding to the collector until direct writes are switched on.
export function getIngestClickHouseConfig(env: NodeJS.ProcessEnv): IngestClickHouseConfig | null {
  if (env.INGEST_CLICKHOUSE_DIRECT !== "true") return null;
  const url = env.CLICKHOUSE_URL;
  if (!url) return null;
  return {
    url,
    database: env.CLICKHOUSE_DB ?? "superlog",
    username: env.CLICKHOUSE_USER ?? "default",
    password: env.CLICKHOUSE_PASSWORD ?? "",
    insertQuorum: readPositiveInt(env.INGEST_CLICKHOUSE_INSERT_QUORUM, 2),
    insertQuorumTimeoutMs: readPositiveInt(env.INGEST_CLICKHOUSE_INSERT_QUORUM_TIMEOUT_MS, 30_000),
    requestTimeoutMs: readPositiveInt(env.INGEST_CLICKHOUSE_REQUEST_TIMEOUT_MS, 30_000),
  };
}

export type IngestTable = "otel_logs" | "otel_traces";

export interface IngestRowWriter {
  insert(table: IngestTable, rows: OtelLogRow[] | OtelTraceRow[]): Promise<void>;
}

export class ClickHouseIngestWriter implements IngestRowWriter {
  private readonly client: ClickHouseClient;

  constructor(config: IngestClickHouseConfig) {
    this.client = createClient({
      url: config.url,
      database: config.database,
      username: config.username,
      password: config.password,
      request_timeout: config.requestTimeoutMs,
      keep_alive: { enabled: true },
      clickhouse_settings: {
        // Mirror the collector's durability: commit to a quorum of replicas before
        // the insert resolves, and keep inserts synchronous (no server-side buffering).
        insert_quorum: String(config.insertQuorum),
        insert_quorum_timeout: config.insertQuorumTimeoutMs,
        async_insert: 0,
        wait_for_async_insert: 1,
      },
    });
  }

  async insert(table: IngestTable, rows: OtelLogRow[] | OtelTraceRow[]): Promise<void> {
    if (rows.length === 0) return;
    // Both row shapes are plain JSON objects; the client just serializes JSONEachRow.
    await this.client.insert({ table, values: rows as OtelLogRow[], format: "JSONEachRow" });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
