import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  ClickHouseIngestWriter,
  type ClickHouseInsertClient,
  type IngestClickHouseConfig,
  clickHouseClientOptions,
  getIngestClickHouseConfig,
} from "./clickhouse-writer.js";
import type { OtelTraceRow } from "./otlp-clickhouse.js";

const config: IngestClickHouseConfig = {
  url: "http://clickhouse:8123",
  database: "superlog",
  username: "writer",
  password: "secret",
  insertQuorum: 2,
  insertQuorumTimeoutMs: 30_000,
  requestTimeoutMs: 30_000,
  batchLingerMs: 5,
  minInsertIntervalMs: 0,
  parallelViewProcessing: false,
  keepAlive: true,
};

function traceRow(traceId: string): OtelTraceRow {
  return { TraceId: traceId } as OtelTraceRow;
}

test("concurrent trace deliveries share one durable ClickHouse insert", async () => {
  let finishInsert: (() => void) | undefined;
  const insertFinished = new Promise<void>((resolve) => {
    finishInsert = resolve;
  });
  const inserts: Array<{ table: string; values: unknown[] }> = [];
  const client: ClickHouseInsertClient = {
    async insert(input) {
      inserts.push({ table: input.table, values: input.values });
      await insertFinished;
    },
    async close() {},
  };
  const writer = new ClickHouseIngestWriter(config, client);

  let firstResolved = false;
  const first = writer.insert("otel_traces", [traceRow("trace-1")]).then(() => {
    firstResolved = true;
  });
  const second = writer.insert("otel_traces", [traceRow("trace-2")]);

  await delay(20);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]?.table, "otel_traces");
  assert.deepEqual(
    inserts[0]?.values.map((row) => (row as OtelTraceRow).TraceId),
    ["trace-1", "trace-2"],
  );
  assert.equal(firstResolved, false, "queue messages must wait for the durable insert");

  finishInsert?.();
  await Promise.all([first, second]);
  assert.equal(firstResolved, true);
  await writer.close();
});

test("deliveries arriving during an insert coalesce into one following insert", async () => {
  let finishFirstInsert: (() => void) | undefined;
  const firstInsertFinished = new Promise<void>((resolve) => {
    finishFirstInsert = resolve;
  });
  const inserts: OtelTraceRow[][] = [];
  const client: ClickHouseInsertClient = {
    async insert(input) {
      inserts.push(input.values as OtelTraceRow[]);
      if (inserts.length === 1) await firstInsertFinished;
    },
    async close() {},
  };
  const writer = new ClickHouseIngestWriter(config, client);

  const first = writer.insert("otel_traces", [traceRow("trace-1")]);
  await delay(20);
  assert.equal(inserts.length, 1);

  const second = writer.insert("otel_traces", [traceRow("trace-2")]);
  await delay(20);
  const third = writer.insert("otel_traces", [traceRow("trace-3")]);
  await delay(20);

  finishFirstInsert?.();
  await Promise.all([first, second, third]);

  assert.equal(inserts.length, 2);
  assert.deepEqual(
    inserts[1]?.map((row) => row.TraceId),
    ["trace-2", "trace-3"],
  );
  await writer.close();
});

test("a failed shared insert rejects every delivery and a later batch can recover", async () => {
  let attempts = 0;
  const client: ClickHouseInsertClient = {
    async insert() {
      attempts += 1;
      if (attempts === 1) throw new Error("quorum unavailable");
    },
    async close() {},
  };
  const writer = new ClickHouseIngestWriter(config, client);

  const first = writer.insert("otel_traces", [traceRow("trace-1")]);
  const second = writer.insert("otel_traces", [traceRow("trace-2")]);
  await assert.rejects(first, /quorum unavailable/);
  await assert.rejects(second, /quorum unavailable/);
  assert.equal(attempts, 1);

  await writer.insert("otel_traces", [traceRow("trace-redelivery")]);
  assert.equal(attempts, 2);
  await writer.close();
});

test("a minimum insert interval spaces consecutive inserts for the same table", async () => {
  const inserts: OtelTraceRow[][] = [];
  const client: ClickHouseInsertClient = {
    async insert(input) {
      inserts.push(input.values as OtelTraceRow[]);
    },
    async close() {},
  };
  const writer = new ClickHouseIngestWriter({ ...config, minInsertIntervalMs: 150 }, client);

  await writer.insert("otel_traces", [traceRow("trace-1")]);
  assert.equal(inserts.length, 1);

  let secondResolved = false;
  const second = writer.insert("otel_traces", [traceRow("trace-2")]).then(() => {
    secondResolved = true;
  });
  const third = writer.insert("otel_traces", [traceRow("trace-3")]);
  await delay(40);
  assert.equal(
    inserts.length,
    1,
    "the next insert waits for the interval since the last one started",
  );
  assert.equal(secondResolved, false);

  await Promise.all([second, third]);
  assert.equal(inserts.length, 2);
  assert.deepEqual(
    inserts[1]?.map((row) => row.TraceId),
    ["trace-2", "trace-3"],
  );
  await writer.close();
});

test("an insert slower than the minimum interval is followed without extra delay", async () => {
  let finishFirstInsert: (() => void) | undefined;
  const firstInsertFinished = new Promise<void>((resolve) => {
    finishFirstInsert = resolve;
  });
  const insertedAt: number[] = [];
  const client: ClickHouseInsertClient = {
    async insert() {
      insertedAt.push(Date.now());
      if (insertedAt.length === 1) await firstInsertFinished;
    },
    async close() {},
  };
  const writer = new ClickHouseIngestWriter({ ...config, minInsertIntervalMs: 50 }, client);

  const first = writer.insert("otel_traces", [traceRow("trace-1")]);
  await delay(20);
  const second = writer.insert("otel_traces", [traceRow("trace-2")]);
  await delay(80);
  const releasedAt = Date.now();
  finishFirstInsert?.();
  await Promise.all([first, second]);

  assert.equal(insertedAt.length, 2);
  assert.ok((insertedAt[1] ?? 0) - releasedAt < 30, "the interval has already elapsed");
  await writer.close();
});

test("close flushes rows that are waiting on the minimum interval", async () => {
  const inserts: OtelTraceRow[][] = [];
  const client: ClickHouseInsertClient = {
    async insert(input) {
      inserts.push(input.values as OtelTraceRow[]);
    },
    async close() {},
  };
  const writer = new ClickHouseIngestWriter({ ...config, minInsertIntervalMs: 60_000 }, client);

  await writer.insert("otel_traces", [traceRow("trace-1")]);
  const second = writer.insert("otel_traces", [traceRow("trace-2")]);
  await delay(20);
  assert.equal(inserts.length, 1);

  await writer.close();
  await second;
  assert.equal(inserts.length, 2);
});

test("config reads insert pacing, parallel views and keep-alive from the environment", () => {
  const base = { INGEST_CLICKHOUSE_DIRECT: "true", CLICKHOUSE_URL: "http://clickhouse:8123" };

  const defaults = getIngestClickHouseConfig(base);
  assert.equal(defaults?.minInsertIntervalMs, 0);
  assert.equal(defaults?.parallelViewProcessing, false);
  assert.equal(defaults?.keepAlive, true);

  const tuned = getIngestClickHouseConfig({
    ...base,
    INGEST_CLICKHOUSE_MIN_INSERT_INTERVAL_MS: "2000",
    INGEST_CLICKHOUSE_PARALLEL_VIEWS: "true",
    INGEST_CLICKHOUSE_KEEP_ALIVE: "false",
  });
  assert.equal(tuned?.minInsertIntervalMs, 2000);
  assert.equal(tuned?.parallelViewProcessing, true);
  assert.equal(tuned?.keepAlive, false);
});

test("client options keep quorum and apply parallel views and keep-alive", () => {
  const defaults = clickHouseClientOptions({
    ...config,
    minInsertIntervalMs: 0,
    parallelViewProcessing: false,
    keepAlive: true,
  });
  assert.equal(defaults.clickhouse_settings?.insert_quorum, "2");
  assert.equal(defaults.clickhouse_settings?.async_insert, 0);
  assert.equal(defaults.clickhouse_settings?.parallel_view_processing, undefined);
  assert.equal(defaults.keep_alive?.enabled, true);

  const tuned = clickHouseClientOptions({
    ...config,
    minInsertIntervalMs: 0,
    parallelViewProcessing: true,
    keepAlive: false,
  });
  assert.equal(tuned.clickhouse_settings?.insert_quorum, "2");
  assert.equal(tuned.clickhouse_settings?.parallel_view_processing, 1);
  assert.equal(tuned.keep_alive?.enabled, false);
});
