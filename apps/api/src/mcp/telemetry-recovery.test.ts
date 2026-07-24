import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executeRecoverableTelemetryQuery,
  recoverTelemetryTimeout,
} from "./telemetry-recovery.js";

test("a telemetry timeout becomes retry guidance without dropping filters", () => {
  const recovery = recoverTelemetryTimeout(
    "query_logs",
    {
      project_id: "project-1",
      service: "checkout-api",
      search: "payment failed",
      range: {
        since: "2026-07-01T00:00:00Z",
        until: "2026-07-22T00:00:00Z",
      },
    },
    new Error("Timeout error."),
  );

  assert.deepEqual(recovery, {
    status: "retry_required",
    tool: "query_logs",
    message:
      "The telemetry query did not complete, but telemetry access is still available. Retry with a narrower time range and keep the same filters.",
    retryable: true,
    suggested_input: {
      project_id: "project-1",
      service: "checkout-api",
      search: "payment failed",
      range: {
        since: "2026-07-21T23:00:00.000Z",
        until: "2026-07-22T00:00:00Z",
      },
    },
  });
});

test("a current or omitted range narrows to the latest hour", () => {
  for (const input of [
    {},
    { range: { since: "now() - INTERVAL 30 DAY", until: "now()" } },
    { range: { since: "now() - INTERVAL 1 MONTH", until: "now()" } },
    { range: { since: "now() - INTERVAL 1 MONTH" } },
  ]) {
    const recovery = recoverTelemetryTimeout(
      "query_traces",
      input,
      new DOMException("", "AbortError"),
    );
    assert.deepEqual(recovery?.suggested_input.range, {
      since: "now() - INTERVAL 1 HOUR",
      until: "now()",
    });
  }
});

test("a historical relative range retries the final hour within that range", () => {
  const recovery = recoverTelemetryTimeout(
    "query_logs",
    {
      range: {
        since: "now() - INTERVAL 30 DAY",
        until: "now() - INTERVAL 1 DAY",
      },
    },
    new Error("Timeout error."),
  );

  assert.deepEqual(recovery?.suggested_input.range, {
    since: "now() - INTERVAL 25 HOUR",
    until: "now() - INTERVAL 1 DAY",
  });
});

test("a historical calendar-month range retries inside its original bounds", () => {
  const recovery = recoverTelemetryTimeout(
    "query_logs",
    {
      range: {
        since: "now() - INTERVAL 2 MONTH",
        until: "now() - INTERVAL 1 MONTH",
      },
    },
    new Error("Timeout error."),
    new Date("2026-07-24T12:00:00Z"),
  );

  assert.deepEqual(recovery?.suggested_input.range, {
    since: "2026-05-24T12:00:00.000Z",
    until: "2026-05-24T13:00:00.000Z",
  });
});

test("a mixed calendar-month range retries inside its original bounds", () => {
  const recovery = recoverTelemetryTimeout(
    "query_logs",
    {
      range: {
        since: "now() - INTERVAL 1 MONTH",
        until: "now() - INTERVAL 1 DAY",
      },
    },
    new Error("Timeout error."),
    new Date("2026-07-24T12:00:00Z"),
  );

  assert.deepEqual(recovery?.suggested_input.range, {
    since: "2026-06-24T12:00:00.000Z",
    until: "2026-06-24T13:00:00.000Z",
  });
});

test("an absolute range shorter than one hour is narrowed within its bounds", () => {
  const recovery = recoverTelemetryTimeout(
    "query_traces",
    {
      range: {
        since: "2026-07-01T00:00:00Z",
        until: "2026-07-01T00:10:00Z",
      },
    },
    new Error("Timeout error."),
  );

  assert.deepEqual(recovery?.suggested_input.range, {
    since: "2026-07-01T00:05:00.000Z",
    until: "2026-07-01T00:10:00Z",
  });
});

test("an absolute range ending at now stays within its lower bound", () => {
  const recovery = recoverTelemetryTimeout(
    "query_traces",
    {
      range: {
        since: "2026-07-24T12:45:00Z",
        until: "now()",
      },
    },
    new Error("Timeout error."),
    new Date("2026-07-24T13:00:00Z"),
  );

  assert.deepEqual(recovery?.suggested_input.range, {
    since: "2026-07-24T12:52:30.000Z",
    until: "now()",
  });
});

test("a historical since-only range retries its first hour", () => {
  const recovery = recoverTelemetryTimeout(
    "query_metrics",
    { range: { since: "2026-07-01T00:00:00Z" } },
    Object.assign(new Error("query exceeded execution time"), {
      code: 159,
      type: "TIMEOUT_EXCEEDED",
    }),
  );

  assert.deepEqual(recovery?.suggested_input.range, {
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-01T01:00:00.000Z",
  });
});

test("permanent telemetry errors are not converted into retry guidance", () => {
  const error = Object.assign(new Error("Unknown table otel_logs"), {
    code: 60,
    type: "UNKNOWN_TABLE",
  });

  assert.equal(recoverTelemetryTimeout("query_logs", {}, error), undefined);
});

test("the MCP boundary returns timeout recovery as a successful value", async () => {
  const observed: unknown[] = [];
  const result = await executeRecoverableTelemetryQuery(
    "list_services",
    { range: { since: "now() - INTERVAL 30 DAY", until: "now()" } },
    async () => {
      throw new Error("Timeout error.");
    },
    (error) => observed.push(error),
  );

  assert.equal(result.status, "retry_required");
  assert.equal(observed.length, 1);
});

test("the MCP boundary still rejects permanent backend failures", async () => {
  const error = Object.assign(new Error("Unknown table otel_logs"), {
    code: 60,
    type: "UNKNOWN_TABLE",
  });
  const observed: unknown[] = [];

  await assert.rejects(
    executeRecoverableTelemetryQuery(
      "query_logs",
      {},
      async () => {
        throw error;
      },
      undefined,
      (cause) => observed.push(cause),
    ),
    (cause) => cause === error,
  );
  assert.deepEqual(observed, [error]);
});
