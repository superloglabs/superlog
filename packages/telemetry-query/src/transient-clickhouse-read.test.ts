import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  getTraceDetail,
  queryLogs,
  queryMetrics,
  queryTraces,
  queryTracesAggregated,
} from "./index.js";

test("a trace read recovers from one transient ClickHouse connection reset", async () => {
  let spanAttempts = 0;
  const clickhouse = {
    async query(input: { query: string }) {
      const readsSpans = /FROM otel_traces\s+WHERE/.test(input.query);
      if (readsSpans && ++spanAttempts === 1) {
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      }
      return {
        async json() {
          return readsSpans ? [{ span_id: "span-1" }] : [];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const detail = await getTraceDetail(clickhouse, "project-1", "trace-1");

  assert.equal(spanAttempts, 2);
  assert.deepEqual(detail.spans, [{ span_id: "span-1" }]);
});

test("a metric read recovers from one transient ClickHouse connection reset", async () => {
  let gaugeAttempts = 0;
  const clickhouse = {
    async query(input: { query: string }) {
      const readsGauge = input.query.includes("FROM otel_metrics_gauge");
      if (readsGauge && ++gaugeAttempts === 1) {
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      }
      return {
        async json() {
          return readsGauge ? [{ kind: "gauge", timestamp: "2026-08-28 07:39:00" }] : [];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const metrics = await queryMetrics(clickhouse, "project-1", {
    metricName: "dialtone.tick.fly-primary",
    limit: 10,
  });

  assert.equal(gaugeAttempts, 2);
  assert.deepEqual(metrics, [{ kind: "gauge", timestamp: "2026-08-28 07:39:00" }]);
});

test("a log read recovers from one transient ClickHouse connection reset", async () => {
  let attempts = 0;
  const clickhouse = {
    async query() {
      if (++attempts === 1) {
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      }
      return {
        async json() {
          return [{ body: "dialtone tick" }];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const logs = await queryLogs(clickhouse, "project-1", { traceId: "trace-1", limit: 1 });

  assert.equal(attempts, 2);
  assert.deepEqual(logs, [{ body: "dialtone tick" }]);
});

test("a trace list recovers from one transient ClickHouse connection reset", async () => {
  let attempts = 0;
  const clickhouse = {
    async query() {
      if (++attempts === 1) {
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      }
      return {
        async json() {
          return [{ trace_id: "trace-1" }];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const traces = await queryTraces(clickhouse, "project-1", { limit: 10 });

  assert.equal(attempts, 2);
  assert.deepEqual(traces, [{ trace_id: "trace-1" }]);
});

test("an aggregated trace list retries a reset table-availability read", async () => {
  let recentProbeAttempts = 0;
  const clickhouse = {
    async query(input: { query: string }) {
      if (input.query.includes("EXISTS TABLE otel_traces_recent")) {
        if (++recentProbeAttempts === 1) {
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        }
        return {
          async json() {
            return [{ result: 1 }];
          },
        };
      }
      if (input.query.includes("EXISTS TABLE otel_traces_summary")) {
        return {
          async json() {
            return [{ result: 1 }];
          },
        };
      }
      if (input.query.includes("SELECT count() AS c")) {
        return {
          async json() {
            return [{ c: 0 }];
          },
        };
      }
      return {
        async json() {
          return [{ trace_id: "trace-1" }];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const traces = await queryTracesAggregated(clickhouse, "project-1", { limit: 10 });

  assert.equal(recentProbeAttempts, 2);
  assert.deepEqual(traces, [{ trace_id: "trace-1" }]);
});

test("an aggregated trace list retries a reset rollup-coverage read", async () => {
  let coverageAttempts = 0;
  const clickhouse = {
    async query(input: { query: string }) {
      if (input.query.startsWith("EXISTS TABLE")) {
        return {
          async json() {
            return [{ result: 1 }];
          },
        };
      }
      if (input.query.includes("SELECT count() AS c")) {
        if (++coverageAttempts === 1) {
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        }
        return {
          async json() {
            return [{ c: 0 }];
          },
        };
      }
      return {
        async json() {
          return [{ trace_id: "trace-1" }];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const traces = await queryTracesAggregated(clickhouse, "project-1", { limit: 10 });

  assert.equal(coverageAttempts, 2);
  assert.deepEqual(traces, [{ trace_id: "trace-1" }]);
});

test("an aggregated trace list retries a reset summary read", async () => {
  let summaryAttempts = 0;
  const clickhouse = {
    async query(input: { query: string }) {
      if (input.query.startsWith("EXISTS TABLE")) {
        return {
          async json() {
            return [{ result: 1 }];
          },
        };
      }
      if (input.query.includes("SELECT count() AS c")) {
        return {
          async json() {
            return [{ c: 1 }];
          },
        };
      }
      if (input.query.includes("FROM otel_traces_summary")) {
        if (++summaryAttempts === 1) {
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        }
      }
      return {
        async json() {
          return [{ trace_id: "trace-1" }];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const traces = await queryTracesAggregated(clickhouse, "project-1", { limit: 10 });

  assert.equal(summaryAttempts, 2);
  assert.deepEqual(traces, [{ trace_id: "trace-1" }]);
});

test("a filtered aggregated trace list retries a reset raw read", async () => {
  let attempts = 0;
  const clickhouse = {
    async query() {
      if (++attempts === 1) {
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      }
      return {
        async json() {
          return [{ trace_id: "trace-1" }];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const traces = await queryTracesAggregated(clickhouse, "project-1", {
    service: "api",
    limit: 10,
  });

  assert.equal(attempts, 2);
  assert.deepEqual(traces, [{ trace_id: "trace-1" }]);
});

test("a log read does not retry a ClickHouse query error", async () => {
  let attempts = 0;
  const clickhouse = {
    async query() {
      attempts += 1;
      throw Object.assign(new Error("unknown table"), { code: "60" });
    },
  } as unknown as ClickHouseClient;

  await assert.rejects(queryLogs(clickhouse, "project-1", { limit: 1 }), /unknown table/);
  assert.equal(attempts, 1);
});

test("a log read surfaces a second connection reset", async () => {
  let attempts = 0;
  const clickhouse = {
    async query() {
      attempts += 1;
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    },
  } as unknown as ClickHouseClient;

  await assert.rejects(queryLogs(clickhouse, "project-1", { limit: 1 }), /read ECONNRESET/);
  assert.equal(attempts, 2);
});
