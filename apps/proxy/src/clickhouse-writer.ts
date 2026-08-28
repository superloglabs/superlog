import { createClient } from "@clickhouse/client";

import type { OtelLogRow, OtelTraceRow } from "./otlp-clickhouse.js";

// Direct-to-ClickHouse ingest writer. Each consumer worker maps OTLP payloads to
// rows, combines concurrent deliveries briefly per table, then INSERTs each batch
// synchronously with insert_quorum. Every caller waits for the shared insert, so an
// SQS message is only deleted once its rows are durably committed (the consume loop
// deletes on success, leaves on throw). Each table has at most one active insert; all
// deliveries received while it runs become one following insert. This keeps concurrent
// queue work from becoming a chain of tiny ClickHouse inserts.
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
  batchLingerMs: number;
};

function readPositiveInt(value: string | undefined, fallback: number): number {
  const n = value === undefined ? Number.NaN : Number(value);
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
    batchLingerMs: readPositiveInt(env.INGEST_CLICKHOUSE_BATCH_LINGER_MS, 10),
  };
}

export type IngestTable = "otel_logs" | "otel_traces";
type IngestRow = OtelLogRow | OtelTraceRow;

export interface IngestRowWriter {
  insert(table: IngestTable, rows: OtelLogRow[] | OtelTraceRow[]): Promise<void>;
}

export interface ClickHouseInsertClient {
  insert(input: {
    table: IngestTable;
    values: IngestRow[];
    format: "JSONEachRow";
  }): Promise<void>;
  close(): Promise<void>;
}

type PendingInsert = {
  rows: IngestRow[];
  resolve: () => void;
  reject: (error: unknown) => void;
};

type TableBatch = {
  pending: PendingInsert[];
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;
};

export class ClickHouseIngestWriter implements IngestRowWriter {
  private readonly client: ClickHouseInsertClient;
  private readonly batchLingerMs: number;
  private readonly batches: Record<IngestTable, TableBatch> = {
    otel_logs: { pending: [], timer: undefined, running: undefined },
    otel_traces: { pending: [], timer: undefined, running: undefined },
  };
  private closed = false;

  constructor(config: IngestClickHouseConfig, client?: ClickHouseInsertClient) {
    this.batchLingerMs = config.batchLingerMs;
    if (client) {
      this.client = client;
    } else {
      const clickhouse = createClient({
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
      this.client = {
        insert: async ({ table, values, format }) => {
          await clickhouse.insert({ table, values: values as OtelLogRow[], format });
        },
        close: () => clickhouse.close(),
      };
    }
  }

  async insert(table: IngestTable, rows: OtelLogRow[] | OtelTraceRow[]): Promise<void> {
    if (rows.length === 0) return;
    if (this.closed) throw new Error("ClickHouse ingest writer is closed");

    return new Promise<void>((resolve, reject) => {
      const batch = this.batches[table];
      batch.pending.push({ rows: rows as IngestRow[], resolve, reject });
      if (!batch.running && !batch.timer) {
        batch.timer = setTimeout(() => this.flush(table), this.batchLingerMs);
      }
    });
  }

  private flush(table: IngestTable): void {
    const batch = this.batches[table];
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = undefined;
    if (batch.running || batch.pending.length === 0) return;

    const pending = batch.pending.splice(0);
    const rows = pending.flatMap((item) => item.rows);
    batch.running = (async () => {
      try {
        // Resolve every included queue delivery only after the shared insert is
        // synchronously committed to the configured replica quorum.
        await this.client.insert({ table, values: rows, format: "JSONEachRow" });
        for (const item of pending) item.resolve();
      } catch (error) {
        for (const item of pending) item.reject(error);
      }
    })().finally(() => {
      batch.running = undefined;
      if (batch.pending.length > 0) {
        // Anything received while ClickHouse was busy has already lingered. Drain
        // all of it as one next insert instead of building a queue of tiny batches.
        this.flush(table);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.flush("otel_logs");
    this.flush("otel_traces");
    await Promise.all(
      Object.values(this.batches).map(async (batch) => {
        while (batch.running) await batch.running;
      }),
    );
    await this.client.close();
  }
}
