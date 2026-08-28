import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  ClickHouseIngestWriter,
  type ClickHouseInsertClient,
  type IngestClickHouseConfig,
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
