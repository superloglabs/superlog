import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { HTTPException } from "hono/http-exception";

// alerts-service.ts transitively imports the db client, which throws at import
// time without a connection string. Set a dummy URL before the dynamic import
// (the postgres client connects lazily, so these pure-function tests never open
// a socket). Same dynamic-import pattern as incidents/detail.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const {
  validateAlertInput,
  alertInputToFilter,
  summarizeEvaluation,
  alertRecordToInput,
  previewAlertSeries,
} = await import("./alerts-service.js");

type AlertInput = Parameters<typeof validateAlertInput>[0];

function baseInput(overrides: Partial<AlertInput> = {}): AlertInput {
  return {
    name: "test alert",
    source: "traces",
    aggregation: "count",
    comparator: "gt",
    threshold: 10,
    ...overrides,
  } as AlertInput;
}

function expectBadRequest(fn: () => void, messageMatch: string): void {
  let err: unknown;
  try {
    fn();
  } catch (caught) {
    err = caught;
  }
  assert.ok(err !== undefined, "expected validateAlertInput to throw");
  assert.ok(err instanceof HTTPException, "expected an HTTPException");
  assert.equal(err.status, 400);
  assert.match(err.message, new RegExp(messageMatch));
}

test("validateAlertInput accepts a valid logs/traces count alert", () => {
  assert.doesNotThrow(() => validateAlertInput(baseInput({ source: "traces" })));
  assert.doesNotThrow(() => validateAlertInput(baseInput({ source: "logs" })));
});

test("validateAlertInput accepts a valid metric alert", () => {
  assert.doesNotThrow(() =>
    validateAlertInput(
      baseInput({ source: "metric", metricName: "http.server.duration", aggregation: "avg" }),
    ),
  );
});

test("validateAlertInput requires metricName when source = metric", () => {
  expectBadRequest(
    () => validateAlertInput(baseInput({ source: "metric", aggregation: "sum", metricName: null })),
    "metricName required",
  );
});

test("validateAlertInput rejects non-count aggregation for logs/traces", () => {
  expectBadRequest(
    () => validateAlertInput(baseInput({ source: "logs", aggregation: "sum" })),
    "must be 'count' for logs/traces",
  );
});

test("validateAlertInput rejects count aggregation for metric source", () => {
  expectBadRequest(
    () =>
      validateAlertInput(baseInput({ source: "metric", metricName: "m", aggregation: "count" })),
    "'sum' or 'avg' for metric",
  );
});

test("validateAlertInput requires groupBy when groupMode = per_group", () => {
  expectBadRequest(
    () => validateAlertInput(baseInput({ groupMode: "per_group", groupBy: null })),
    "groupBy required",
  );
  assert.doesNotThrow(() =>
    validateAlertInput(baseInput({ groupMode: "per_group", groupBy: "service.name" })),
  );
});

test("alertInputToFilter keeps only the filter fields", () => {
  const filter = alertInputToFilter(
    baseInput({
      groupBy: "service.name",
      groupMode: "per_group",
      filter: {
        resourceAttrs: [{ key: "deployment.environment", value: "prod" }],
        service: "checkout",
        severity: "ERROR",
        spanName: "POST /pay",
        statusCode: "500",
        minDurationMs: 250,
      },
    }),
  );

  assert.deepEqual(filter, {
    resourceAttrs: [{ key: "deployment.environment", value: "prod" }],
    service: "checkout",
    severity: "ERROR",
    spanName: "POST /pay",
    statusCode: "500",
    minDurationMs: 250,
  });
});

test("alertInputToFilter returns undefined fields when no filter is provided", () => {
  const filter = alertInputToFilter(baseInput());
  assert.deepEqual(filter, {
    resourceAttrs: undefined,
    service: undefined,
    severity: undefined,
    spanName: undefined,
    statusCode: undefined,
    minDurationMs: undefined,
  });
});

test("summarizeEvaluation single mode reports the total and a 0/1 breach count", () => {
  const alert = {
    comparator: "gt" as const,
    threshold: 10,
    groupMode: "single" as const,
    groupBy: null,
  };

  const below = summarizeEvaluation(alert, { groups: new Map([["", 5]]), total: 5 });
  assert.deepEqual(below, { mode: "single", value: 5, breaches: 0 });

  const above = summarizeEvaluation(alert, { groups: new Map([["", 15]]), total: 15 });
  assert.deepEqual(above, { mode: "single", value: 15, breaches: 1 });
});

test("summarizeEvaluation single mode respects the lt comparator", () => {
  const alert = {
    comparator: "lt" as const,
    threshold: 10,
    groupMode: "single" as const,
    groupBy: null,
  };
  const result = summarizeEvaluation(alert, { groups: new Map(), total: 5 });
  assert.deepEqual(result, { mode: "single", value: 5, breaches: 1 });
});

test("summarizeEvaluation per_group mode sorts by value desc and counts breaches", () => {
  const alert = {
    comparator: "gt" as const,
    threshold: 10,
    groupMode: "per_group" as const,
    groupBy: "service.name",
  };
  const result = summarizeEvaluation(alert, {
    groups: new Map([
      ["g1", 1],
      ["g2", 50],
      ["g3", 11],
    ]),
    total: 62,
  });

  assert.equal(result.mode, "per_group");
  if (result.mode !== "per_group") return; // narrow for TS
  assert.deepEqual(
    result.groups.map((g) => g.key),
    ["g2", "g3", "g1"],
  );
  assert.deepEqual(
    result.groups.map((g) => g.breaching),
    [true, true, false],
  );
  assert.equal(result.breaches, 2);
});

test("summarizeEvaluation falls back to single mode when groupBy is missing", () => {
  const alert = {
    comparator: "gt" as const,
    threshold: 10,
    groupMode: "per_group" as const,
    groupBy: null,
  };
  const result = summarizeEvaluation(alert, {
    groups: new Map([["a", 99]]),
    total: 99,
  });
  assert.deepEqual(result, { mode: "single", value: 99, breaches: 1 });
});

test("alertRecordToInput maps a metric alert row to the preview input shape", () => {
  const input = alertRecordToInput({
    name: "queue depth",
    source: "metric",
    metricName: "pgboss.oldest_pending_ms",
    filter: { service: "worker", resourceAttrs: [{ key: "env", value: "prod" }] },
    groupBy: null,
    groupMode: "single",
    aggregation: "avg",
    comparator: "gt",
    threshold: 300000,
    windowMinutes: 5,
  });
  assert.deepEqual(input, {
    name: "queue depth",
    source: "metric",
    metricName: "pgboss.oldest_pending_ms",
    filter: { service: "worker", resourceAttrs: [{ key: "env", value: "prod" }] },
    groupBy: null,
    groupMode: "single",
    aggregation: "avg",
    comparator: "gt",
    threshold: 300000,
    windowMinutes: 5,
  });
  // Round-trips through the filter extractor the series builder uses.
  assert.deepEqual(alertInputToFilter(input), {
    resourceAttrs: [{ key: "env", value: "prod" }],
    service: "worker",
    severity: undefined,
    spanName: undefined,
    statusCode: undefined,
    minDurationMs: undefined,
  });
});

test("alertRecordToInput passes through the stored default empty jsonb filter", () => {
  const input = alertRecordToInput({
    name: "error rate",
    source: "logs",
    metricName: null,
    // Stored default for the `filter` column is `{}` (never null in practice).
    filter: {},
    groupBy: "service.name",
    groupMode: "per_group",
    aggregation: "count",
    comparator: "gt",
    threshold: 10,
    windowMinutes: 15,
  });
  assert.deepEqual(input.filter, {});
  assert.equal(input.source, "logs");
  assert.equal(input.groupMode, "per_group");
});

test("previewAlertSeries scopes an explicitly empty per-group key", async () => {
  let query = "";
  let params: Record<string, unknown> | undefined;
  const ch = {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      query = input.query;
      params = input.query_params;
      return {
        async json() {
          return [
            { bucket: "2026-07-14 10:00:00", group_key: "", c: 2 },
            { bucket: "2026-07-14 10:00:00", group_key: "checkout", c: 7 },
          ];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const result = await previewAlertSeries(
    ch,
    "project-1",
    baseInput({
      source: "logs",
      groupMode: "per_group",
      groupBy: "attr:team",
      windowMinutes: 5,
    }),
    "",
  );

  assert.match(query, /LogAttributes\[\{groupKey:String\}\]/);
  assert.equal(params?.groupKey, "team");
  assert.deepEqual(
    result.rows.map((row) => row.value),
    [2],
  );
});
