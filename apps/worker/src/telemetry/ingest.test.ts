import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DB } from "@superlog/db";
import { createTelemetryIngestor } from "./ingest.js";

type QueryCall = {
  query: string;
  query_params?: Record<string, unknown>;
  format: "JSONEachRow";
};

function fakeDb(): {
  database: DB;
  state: Map<string, { cursor: Date }>;
} {
  const state = new Map<string, { cursor: Date }>();
  state.set("fingerprint", { cursor: new Date("2026-05-23T10:00:00.000Z") });
  state.set("fingerprint-logs", { cursor: new Date("2026-05-23T10:00:00.000Z") });
  const database = {
    query: {
      workerState: {
        async findFirst(args?: { where?: unknown }) {
          const where = args?.where;
          if (typeof where !== "function") return undefined;
          const columns = { name: "name" };
          const operators = { eq: (_column: unknown, value: string) => ({ value }) };
          const filter = where(columns, operators) as { value?: string };
          return filter.value ? state.get(filter.value) : undefined;
        },
      },
      projectAutomationSettings: {
        async findMany() {
          return [];
        },
      },
    },
    insert() {
      return {
        values(values: { name: string; cursor: Date }) {
          return {
            async onConflictDoUpdate() {
              state.set(values.name, {
                cursor: values.cursor,
              });
            },
          };
        },
      };
    },
  } as unknown as DB;
  return { database, state };
}

test("span ingestion processes every row for a selected timestamp", async () => {
  const { database, state } = fakeDb();
  let callCount = 0;
  const calls: QueryCall[] = [];
  const rows = [
    spanRow({ traceId: "trace-a", spanId: "span-a", message: "first" }),
    spanRow({ traceId: "trace-a", spanId: "span-a", message: "first" }),
  ];
  const clickhouse = {
    async query(input: QueryCall) {
      calls.push(input);
      const row = callCount === 0 ? rows : [];
      callCount += 1;
      return {
        async json() {
          return row;
        },
      };
    },
  };
  const ingestor = createTelemetryIngestor({
    clickhouse,
    database,
    batchSize: 1,
    async handleIssueTransition() {},
  });

  assert.equal(await ingestor.tickSpans(), 2);
  assert.match(calls[0]?.query ?? "", /GROUP BY Timestamp/);
  assert.equal("cursorKey0" in (calls[0]?.query_params ?? {}), false);
  assert.equal(calls[0]?.query_params?.cursorTs, "2026-05-23 10:00:00.000");
  assert.equal(state.get("fingerprint")?.cursor.toISOString(), "2026-05-23T10:00:00.000Z");
});

test("log ingestion processes every row for a selected timestamp", async () => {
  const { database, state } = fakeDb();
  let callCount = 0;
  const calls: QueryCall[] = [];
  const rows = [
    logRow({ traceId: "trace-a", spanId: "span-a", body: "first" }),
    logRow({ traceId: "trace-a", spanId: "span-a", body: "first" }),
  ];
  const clickhouse = {
    async query(input: QueryCall) {
      calls.push(input);
      const row = callCount === 0 ? rows : [];
      callCount += 1;
      return {
        async json() {
          return row;
        },
      };
    },
  };
  const ingestor = createTelemetryIngestor({
    clickhouse,
    database,
    batchSize: 1,
    async handleIssueTransition() {},
  });

  assert.equal(await ingestor.tickLogs(), 2);
  assert.match(calls[0]?.query ?? "", /GROUP BY Timestamp/);
  assert.equal("cursorKey0" in (calls[0]?.query_params ?? {}), false);
  assert.equal(calls[0]?.query_params?.cursorTs, "2026-05-23 10:00:00.000");
  assert.equal(state.get("fingerprint-logs")?.cursor.toISOString(), "2026-05-23T10:00:00.000Z");
});

test("span ingestion bounds discovery to a configured window and advances empty windows", async () => {
  const { database, state } = fakeDb();
  const calls: QueryCall[] = [];
  const clickhouse = {
    async query(input: QueryCall) {
      calls.push(input);
      return {
        async json() {
          return [];
        },
      };
    },
  };
  const ingestor = createTelemetryIngestor({
    clickhouse,
    database,
    batchSize: 500,
    discoveryWindowMs: 60_000,
    now: () => new Date("2026-05-23T10:10:00.000Z"),
    async handleIssueTransition() {},
  });

  assert.equal(await ingestor.tickSpans(), 0);
  assert.match(
    calls[0]?.query ?? "",
    /Timestamp <= parseDateTime64BestEffort\({untilTs:String}, 6\)/,
  );
  assert.equal(calls[0]?.query_params?.cursorTs, "2026-05-23 10:00:00.000");
  assert.equal(calls[0]?.query_params?.untilTs, "2026-05-23 10:01:00.000");
  assert.equal(state.get("fingerprint")?.cursor.toISOString(), "2026-05-23T10:01:00.000Z");
});

test("log ingestion bounds discovery to a configured window and advances empty windows", async () => {
  const { database, state } = fakeDb();
  const calls: QueryCall[] = [];
  const clickhouse = {
    async query(input: QueryCall) {
      calls.push(input);
      return {
        async json() {
          return [];
        },
      };
    },
  };
  const ingestor = createTelemetryIngestor({
    clickhouse,
    database,
    batchSize: 500,
    discoveryWindowMs: 60_000,
    now: () => new Date("2026-05-23T10:10:00.000Z"),
    async handleIssueTransition() {},
  });

  assert.equal(await ingestor.tickLogs(), 0);
  assert.match(
    calls[0]?.query ?? "",
    /Timestamp <= parseDateTime64BestEffort\({untilTs:String}, 6\)/,
  );
  assert.equal(calls[0]?.query_params?.cursorTs, "2026-05-23 10:00:00.000");
  assert.equal(calls[0]?.query_params?.untilTs, "2026-05-23 10:01:00.000");
  assert.equal(state.get("fingerprint-logs")?.cursor.toISOString(), "2026-05-23T10:01:00.000Z");
});

test("span ingestion rounds sub-millisecond discovery windows up to one millisecond", async () => {
  const { database, state } = fakeDb();
  const calls: QueryCall[] = [];
  const clickhouse = {
    async query(input: QueryCall) {
      calls.push(input);
      return {
        async json() {
          return [];
        },
      };
    },
  };
  const ingestor = createTelemetryIngestor({
    clickhouse,
    database,
    batchSize: 500,
    discoveryWindowMs: 0.5,
    now: () => new Date("2026-05-23T10:10:00.000Z"),
    async handleIssueTransition() {},
  });

  assert.equal(await ingestor.tickSpans(), 0);
  assert.equal(calls[0]?.query_params?.untilTs, "2026-05-23 10:00:00.001");
  assert.equal(state.get("fingerprint")?.cursor.toISOString(), "2026-05-23T10:00:00.001Z");
});

function spanRow(opts: { traceId: string; spanId: string; message: string }) {
  return {
    ts: "2026-05-23 10:00:00.000000",
    project_id: "not-a-project",
    service: "api",
    span_name: "request",
    trace_id: opts.traceId,
    span_id: opts.spanId,
    exc_type: "Error",
    exc_message: opts.message,
    exc_stack: "stack",
    span_attrs: {},
    resource_attrs: {},
  };
}

function logRow(opts: { traceId: string; spanId: string; body: string }) {
  return {
    ts: "2026-05-23 10:00:00.000000",
    project_id: "not-a-project",
    service: "api",
    severity: "ERROR",
    severity_number: 17,
    body: opts.body,
    trace_id: opts.traceId,
    span_id: opts.spanId,
    log_attrs: {},
    resource_attrs: {},
    exc_type: "Error",
    exc_stack: "stack",
  };
}
