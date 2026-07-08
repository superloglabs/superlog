import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RenderMetricSeries } from "./client.js";
import {
  advanceLogCursor,
  advanceSeriesCursor,
  filterLogsAfterCursor,
  filterSeriesAfterCursor,
  renderLogsToOtlp,
  renderMetricsToOtlp,
  rfc3339ToNanos,
  seriesCursorKey,
  stripAnsi,
} from "./transform.js";

// Index into an array with narrowing (strict indexing forbids bare [0]).
function at<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  assert.ok(item !== undefined, `expected item at index ${index}`);
  return item;
}

const NAMES = {
  serviceNamesById: { "srv-1": "acme-api" },
  ownerId: "tea-1",
  ownerName: "Acme",
};

const LOG = {
  id: "log-1",
  timestamp: "2026-07-07T14:10:31.058154105Z",
  message: "--> GET / \u001b[32m200\u001b[0m 1ms",
  labels: [
    { name: "resource", value: "srv-1" },
    { name: "level", value: "info" },
    { name: "instance", value: "srv-1-abcde" },
    { name: "type", value: "app" },
  ],
};

test("rfc3339ToNanos keeps sub-millisecond precision", () => {
  assert.equal(rfc3339ToNanos("2026-07-07T14:10:31.058154105Z"), 1783433431058154105n);
  assert.equal(rfc3339ToNanos("2026-07-07T14:10:31Z"), 1783433431000000000n);
  // Render emits offset timestamps too (e.g. -07:00).
  assert.equal(rfc3339ToNanos("2026-07-07T07:10:31.058154105-07:00"), 1783433431058154105n);
  assert.equal(rfc3339ToNanos("garbage"), null);
});

test("stripAnsi removes color sequences", () => {
  assert.equal(stripAnsi("--> GET / \u001b[32m200\u001b[0m 1ms"), "--> GET / 200 1ms");
});

test("renderLogsToOtlp maps a Render log line to an OTLP log record", () => {
  const out = renderLogsToOtlp([LOG], NAMES);
  assert.equal(out.resourceLogs.length, 1);
  const rl = at(out.resourceLogs, 0);
  const resourceAttrs = Object.fromEntries(
    rl.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "acme-api");
  assert.equal(resourceAttrs["telemetry.source"], "render");
  assert.equal(resourceAttrs["render.owner_id"], "tea-1");
  assert.equal(resourceAttrs["render.owner_name"], "Acme");
  assert.equal(resourceAttrs["render.service_id"], "srv-1");

  const record = at(at(rl.scopeLogs, 0).logRecords, 0);
  assert.equal(record.timeUnixNano, "1783433431058154105");
  assert.equal(record.severityText, "INFO");
  assert.equal(record.severityNumber, 9);
  assert.equal(record.body.stringValue, "--> GET / 200 1ms");
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["render.log_id"], "log-1");
  assert.equal(attrs["render.attr.instance"], "srv-1-abcde");
  assert.equal(attrs["render.attr.type"], "app");
  // resource/level shape the record itself; they don't repeat as attributes.
  assert.equal(attrs["render.attr.resource"], undefined);
  assert.equal(attrs["render.attr.level"], undefined);
});

test("renderLogsToOtlp falls back to 'render' when the resource is unknown", () => {
  const out = renderLogsToOtlp([{ ...LOG, labels: [] }], NAMES);
  const rl = at(out.resourceLogs, 0);
  const resourceAttrs = Object.fromEntries(
    rl.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "render");
  assert.equal(resourceAttrs["render.service_id"], undefined);
});

const SERIES: RenderMetricSeries = {
  labels: [
    { field: "resource", value: "srv-1" },
    { field: "instance", value: "srv-1-abcde" },
  ],
  unit: "GB",
  values: [
    { timestamp: "2026-07-07T14:10:00Z", value: 0.5 },
    { timestamp: "2026-07-07T14:11:00Z", value: 0.75 },
  ],
};

test("renderMetricsToOtlp maps series to gauges grouped by resource", () => {
  const out = renderMetricsToOtlp("memory", [SERIES], NAMES);
  assert.equal(out.resourceMetrics.length, 1);
  const rm = at(out.resourceMetrics, 0);
  const resourceAttrs = Object.fromEntries(
    rm.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "acme-api");
  assert.equal(resourceAttrs["telemetry.source"], "render");
  assert.equal(resourceAttrs["render.service_id"], "srv-1");

  const metric = at(at(rm.scopeMetrics, 0).metrics, 0);
  assert.equal(metric.name, "render.memory.usage");
  // The API-reported unit wins over the fallback.
  assert.equal(metric.unit, "GB");
  assert.equal(metric.gauge.dataPoints.length, 2);
  const point = at(metric.gauge.dataPoints, 0);
  assert.equal(point.asDouble, 0.5);
  assert.equal(point.timeUnixNano, `${BigInt(Date.parse("2026-07-07T14:10:00Z")) * 1_000_000n}`);
  const pointAttrs = Object.fromEntries(
    (point.attributes ?? []).map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(pointAttrs["render.instance"], "srv-1-abcde");
});

test("renderMetricsToOtlp uses the fallback unit and drops empty series", () => {
  const noUnit: RenderMetricSeries = { ...SERIES, unit: null };
  const empty: RenderMetricSeries = { ...SERIES, values: [] };
  const out = renderMetricsToOtlp("cpu", [noUnit, empty], NAMES);
  assert.equal(out.resourceMetrics.length, 1);
  const metric = at(at(at(out.resourceMetrics, 0).scopeMetrics, 0).metrics, 0);
  assert.equal(metric.name, "render.cpu.usage");
  assert.equal(metric.unit, "{cpu}");
});

test("log cursor filters already-forwarded lines and advances to the max", () => {
  const older = { ...LOG, timestamp: "2026-07-07T14:10:30Z" };
  const newer = { ...LOG, id: "log-9", timestamp: "2026-07-07T14:10:32Z" };
  // Legacy timestamp-only cursors are still accepted on read.
  const cursor = { oregon: "2026-07-07T14:10:31Z" };

  const fresh = filterLogsAfterCursor(cursor, "oregon", [older, LOG, newer]);
  assert.deepEqual(
    fresh.map((l) => l.timestamp),
    ["2026-07-07T14:10:31.058154105Z", "2026-07-07T14:10:32Z"],
  );
  // A different group is unaffected by this group's cursor.
  assert.equal(filterLogsAfterCursor(cursor, "frankfurt", [older]).length, 1);

  const advanced = advanceLogCursor(cursor, "oregon", [older, LOG, newer]);
  assert.deepEqual(advanced.oregon, { ts: "2026-07-07T14:10:32Z", ids: ["log-9"] });
  // Never moves backwards.
  const unchanged = advanceLogCursor(advanced, "oregon", [older]);
  assert.deepEqual(unchanged.oregon, { ts: "2026-07-07T14:10:32Z", ids: ["log-9"] });
});

test("boundary-timestamp lines are re-read and deduped by id, not dropped", () => {
  // A pass can end mid-group: two lines share the boundary timestamp but only
  // the first was fetched. The cursor carries the forwarded ids so the second
  // line survives the next pass's filter.
  const ts = "2026-07-07T14:10:32Z";
  const seen = { ...LOG, id: "log-a", timestamp: ts };
  const unseen = { ...LOG, id: "log-b", timestamp: ts };

  const cursor = advanceLogCursor({}, "oregon", [seen]);
  assert.deepEqual(cursor.oregon, { ts, ids: ["log-a"] });

  const fresh = filterLogsAfterCursor(cursor, "oregon", [seen, unseen]);
  assert.deepEqual(
    fresh.map((l) => l.id),
    ["log-b"],
  );
  // A boundary line without an id can't be deduped — treated as seen rather
  // than re-forwarded forever.
  assert.equal(
    filterLogsAfterCursor(cursor, "oregon", [{ ...LOG, id: null, timestamp: ts }]).length,
    0,
  );

  // Advancing on the same boundary accumulates ids instead of resetting.
  const merged = advanceLogCursor(cursor, "oregon", [unseen]);
  assert.deepEqual(merged.oregon, { ts, ids: ["log-a", "log-b"] });
});

test("series cursor filters old samples per key and advances in epoch seconds", () => {
  const key = "srv-1:memory";
  const cursor = { [key]: Date.parse("2026-07-07T14:10:00Z") / 1000 };

  const fresh = filterSeriesAfterCursor(cursor, key, [SERIES]);
  assert.equal(fresh.length, 1);
  assert.deepEqual(
    at(fresh, 0).values.map((v) => v.timestamp),
    ["2026-07-07T14:11:00Z"],
  );
  // Fully-deduped series disappear.
  const none = filterSeriesAfterCursor({ [key]: Date.parse("2026-07-07T14:11:00Z") / 1000 }, key, [
    SERIES,
  ]);
  assert.equal(none.length, 0);

  const advanced = advanceSeriesCursor(cursor, key, [SERIES]);
  assert.equal(advanced[key], Date.parse("2026-07-07T14:11:00Z") / 1000);
  // Untouched cursor object is returned when there's nothing to advance.
  const same = advanceSeriesCursor(advanced, key, []);
  assert.equal(same[key], advanced[key]);
});

test("seriesCursorKey distinguishes instances so a fast one can't advance past a laggard", () => {
  const instanceA: RenderMetricSeries = { ...SERIES };
  const instanceB: RenderMetricSeries = {
    ...SERIES,
    labels: [
      { field: "resource", value: "srv-1" },
      { field: "instance", value: "srv-1-zzzzz" },
    ],
  };
  const keyA = seriesCursorKey("srv-1", "memory", instanceA);
  const keyB = seriesCursorKey("srv-1", "memory", instanceB);
  assert.notEqual(keyA, keyB);
  // Advancing A's cursor leaves B's series untouched.
  const cursor = advanceSeriesCursor({}, keyA, [instanceA]);
  assert.equal(filterSeriesAfterCursor(cursor, keyB, [instanceB]).length, 1);
  // Label order doesn't change the key; a label-less series still keys cleanly.
  assert.equal(
    seriesCursorKey("srv-1", "memory", {
      ...instanceA,
      labels: [...instanceA.labels].reverse(),
    }),
    keyA,
  );
  assert.equal(
    seriesCursorKey("srv-1", "cpu", { labels: [], unit: null, values: [] }),
    "srv-1:cpu",
  );
});
