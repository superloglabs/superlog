import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type { schema } from "@superlog/db";
import { createAlertMetricsRepository } from "./metrics-repository.js";

function makeAlert(overrides: Partial<schema.Alert> = {}): schema.Alert {
  return {
    id: "alert-1",
    projectId: "project-1",
    name: "Nginx 422s",
    enabled: true,
    source: "logs",
    metricName: null,
    filter: {},
    groupBy: null,
    groupMode: "single",
    aggregation: "count",
    comparator: "gt",
    threshold: 2,
    windowMinutes: 15,
    evaluationIntervalSeconds: 60,
    createdBy: "user-1",
    lastEvaluatedAt: null,
    createdAt: new Date("2026-08-06T09:00:00.000Z"),
    updatedAt: new Date("2026-08-06T09:00:00.000Z"),
    ...overrides,
  } satisfies schema.Alert;
}

test("live alert evaluation counts logs matching per-record attributes", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};
  const ch = {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      capture.query = input.query;
      capture.params = input.query_params;
      return { json: async () => [{ group_key: "", v: "3" }] };
    },
  } as unknown as ClickHouseClient;
  const repo = createAlertMetricsRepository(ch);

  const counts = await repo.aggregateCount(
    makeAlert({
      filter: {
        logAttrs: [
          { key: "gcp.http_request.status", value: "422" },
          { key: "gcp.http_request.requestUrl", value: "/api/captains/stripe/connect" },
        ],
      },
    } as Partial<schema.Alert>),
    { since: "2026-08-06T10:00:00.000Z", until: "2026-08-06T10:15:00.000Z" },
  );

  assert.equal(counts.get(""), 3);
  assert.match(capture.query ?? "", /LogAttributes\[\{aalert_log_k_0:String\}\]/);
  assert.match(capture.query ?? "", /LogAttributes\[\{aalert_log_k_1:String\}\]/);
  assert.equal(capture.params?.aalert_log_k_0, "gcp.http_request.status");
  assert.equal(capture.params?.aalert_log_v_0, "422");
  assert.equal(capture.params?.aalert_log_k_1, "gcp.http_request.requestUrl");
});

test("live alert evaluation groups logs by a per-record attribute", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};
  const ch = {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      capture.query = input.query;
      capture.params = input.query_params;
      return { json: async () => [{ group_key: "422", v: "3" }] };
    },
  } as unknown as ClickHouseClient;
  const repo = createAlertMetricsRepository(ch);

  const counts = await repo.aggregateCount(
    makeAlert({ groupBy: "log.gcp.http_request.status", groupMode: "per_group" }),
    { since: "2026-08-06T10:00:00.000Z", until: "2026-08-06T10:15:00.000Z" },
  );

  assert.equal(counts.get("422"), 3);
  assert.match(capture.query ?? "", /LogAttributes\[\{aalert_groupKey:String\}\]/);
  assert.equal(capture.params?.aalert_groupKey, "gcp.http_request.status");
});

test("live alert evaluation does not reinterpret an incompatible scoped group as a resource", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};
  const ch = {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      capture.query = input.query;
      capture.params = input.query_params;
      return { json: async () => [{ group_key: "", v: "3" }] };
    },
  } as unknown as ClickHouseClient;
  const repo = createAlertMetricsRepository(ch);

  await repo.aggregateCount(
    makeAlert({ source: "traces", groupBy: "log.gcp.http_request.status" }),
    { since: "2026-08-06T10:00:00.000Z", until: "2026-08-06T10:15:00.000Z" },
  );

  assert.match(capture.query ?? "", /'' AS group_key/);
  assert.equal(capture.params?.aalert_groupKey, undefined);
});
