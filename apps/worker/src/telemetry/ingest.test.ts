import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DB, schema } from "@superlog/db";
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
  // Reads the exception-only projection, not ARRAY JOIN Events over otel_traces.
  assert.match(calls[0]?.query ?? "", /FROM otel_exceptions/);
  assert.match(calls[0]?.query ?? "", /kind = 'span'/);
  assert.doesNotMatch(calls[0]?.query ?? "", /ARRAY JOIN/);
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
  // Reads the exception-only projection (kind='log'), not a full otel_logs scan.
  assert.match(calls[0]?.query ?? "", /FROM otel_exceptions/);
  assert.match(calls[0]?.query ?? "", /kind = 'log'/);
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

const VALID_PROJECT_ID = "11111111-1111-4111-8111-111111111111";

// A fake DB whose project resolves (valid UUID) so rows reach `upsertIssue`.
// `execute` runs `onExecute(call#)` so a test can make a specific row's upsert
// throw — simulating the Postgres `22021` NUL-byte rejection that used to wedge
// the whole batch.
function fakeDbWithProject(opts: { onExecute?: (call: number) => void }): {
  database: DB;
  state: Map<string, { cursor: Date }>;
  executeCalls: () => number;
} {
  const state = new Map<string, { cursor: Date }>();
  state.set("fingerprint", { cursor: new Date("2026-05-23T10:00:00.000Z") });
  state.set("fingerprint-logs", { cursor: new Date("2026-05-23T10:00:00.000Z") });
  let calls = 0;
  const database = {
    query: {
      workerState: {
        async findFirst(args?: { where?: unknown }) {
          const where = args?.where;
          if (typeof where !== "function") return undefined;
          const filter = where(
            { name: "name" },
            { eq: (_c: unknown, value: string) => ({ value }) },
          ) as { value?: string };
          return filter.value ? state.get(filter.value) : undefined;
        },
      },
      projectAutomationSettings: {
        async findMany() {
          return [];
        },
      },
      issues: {
        async findFirst() {
          return { id: "issue-1", projectId: VALID_PROJECT_ID } as unknown as schema.Issue;
        },
      },
    },
    select() {
      return {
        from() {
          return {
            async where() {
              return [{ id: VALID_PROJECT_ID }];
            },
          };
        },
      };
    },
    async execute() {
      calls += 1;
      opts.onExecute?.(calls);
      return [
        { id: "issue-1", xmax: "0", prev_issue_id: null, prev_incident_status: null },
      ] as unknown as never;
    },
    insert() {
      return {
        values(values: { name: string; cursor: Date }) {
          return {
            async onConflictDoUpdate() {
              state.set(values.name, { cursor: values.cursor });
            },
          };
        },
      };
    },
  } as unknown as DB;
  return { database, state, executeCalls: () => calls };
}

test("log ingestion isolates a failing row and still advances past it", async () => {
  // First row's upsert throws (mimics PG 22021 NUL-byte rejection). The tick
  // must NOT throw, must still process the second row, and must advance the
  // cursor past the poison row so ingestion is never wedged.
  const { database, state, executeCalls } = fakeDbWithProject({
    onExecute: (call) => {
      if (call === 1) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
    },
  });
  // Distinct exc_type => distinct fingerprints => two separate upsert groups.
  const rows = [
    {
      ...logRow({ traceId: "t1", spanId: "s1", body: "poison" }),
      project_id: VALID_PROJECT_ID,
      exc_type: "PoisonError",
    },
    {
      ...logRow({ traceId: "t2", spanId: "s2", body: "healthy" }),
      project_id: VALID_PROJECT_ID,
      exc_type: "HealthyError",
      ts: "2026-05-23 10:00:01.000000",
    },
  ];
  let callCount = 0;
  const clickhouse = {
    async query() {
      const out = callCount === 0 ? rows : [];
      callCount += 1;
      return {
        async json() {
          return out;
        },
      };
    },
  };
  const ingestor = createTelemetryIngestor({
    clickhouse,
    database,
    batchSize: 2,
    async handleIssueTransition() {},
  });

  const processed = await ingestor.tickLogs();
  assert.equal(processed, 2);
  // Both groups attempted (the poison group did not abort the flush).
  assert.equal(executeCalls(), 2);
  // Cursor advanced past the poison row to the healthy row's timestamp.
  assert.equal(state.get("fingerprint-logs")?.cursor.toISOString(), "2026-05-23T10:00:01.000Z");
});

test("log ingestion collapses same-fingerprint rows into a single upsert", async () => {
  // An exception storm: many rows, one fingerprint. Must be ONE upsert, not N.
  const { database, state, executeCalls } = fakeDbWithProject({});
  const rows = [
    { ...logRow({ traceId: "t1", spanId: "s1", body: "boom" }), project_id: VALID_PROJECT_ID },
    {
      ...logRow({ traceId: "t2", spanId: "s2", body: "boom" }),
      project_id: VALID_PROJECT_ID,
      ts: "2026-05-23 10:00:01.000000",
    },
    {
      ...logRow({ traceId: "t3", spanId: "s3", body: "boom" }),
      project_id: VALID_PROJECT_ID,
      ts: "2026-05-23 10:00:02.000000",
    },
  ];
  let callCount = 0;
  const clickhouse = {
    async query() {
      const out = callCount === 0 ? rows : [];
      callCount += 1;
      return {
        async json() {
          return out;
        },
      };
    },
  };
  const ingestor = createTelemetryIngestor({
    clickhouse,
    database,
    batchSize: 10,
    async handleIssueTransition() {},
  });

  assert.equal(await ingestor.tickLogs(), 3);
  // Three rows, one fingerprint => exactly one upsert round-trip.
  assert.equal(executeCalls(), 1);
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
