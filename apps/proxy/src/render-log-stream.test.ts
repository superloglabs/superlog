import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseRenderLogStreamBody, renderStreamLogsToOtlp } from "./render-log-stream.js";

// Index into an array with narrowing (strict indexing forbids bare [0]).
function at<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  assert.ok(item !== undefined, `expected item at index ${index}`);
  return item;
}

test("parses a JSON array, an envelope, and NDJSON", () => {
  const record = { message: "hi", timestamp: "2026-07-08T10:00:00Z" };
  assert.equal(
    parseRenderLogStreamBody(Buffer.from(JSON.stringify([record, record])), "application/json")
      .length,
    2,
  );
  assert.equal(
    parseRenderLogStreamBody(
      Buffer.from(JSON.stringify({ logs: [record] })),
      "application/json",
    ).length,
    1,
  );
  const ndjson = `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`;
  assert.equal(parseRenderLogStreamBody(Buffer.from(ndjson), "application/x-ndjson").length, 2);
  // NDJSON mislabeled as application/json still parses.
  assert.equal(parseRenderLogStreamBody(Buffer.from(ndjson), "application/json").length, 2);
  assert.equal(parseRenderLogStreamBody(Buffer.from(""), "application/json").length, 0);
});

test("maps Render's labels shape to an OTLP record", () => {
  const out = renderStreamLogsToOtlp([
    {
      id: "log-1",
      timestamp: "2026-07-08T10:00:00.123456789Z",
      message: "GET /health 200",
      labels: [
        { name: "resource", value: "srv-abc" },
        { name: "app", value: "acme-api" },
        { name: "instance", value: "srv-abc-xyz" },
        { name: "level", value: "info" },
        { name: "type", value: "app" },
      ],
    },
  ]);
  const rl = at(out.resourceLogs, 0);
  const resourceAttrs = Object.fromEntries(
    rl.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "acme-api");
  assert.equal(resourceAttrs["telemetry.source"], "render");
  assert.equal(resourceAttrs["render.service_id"], "srv-abc");
  assert.equal(resourceAttrs["render.service_type"], "app");

  const record = at(at(rl.scopeLogs, 0).logRecords, 0);
  assert.equal(record.severityText, "INFO");
  assert.equal(record.body.stringValue, "GET /health 200");
  assert.equal(record.timeUnixNano, `${BigInt(Date.parse("2026-07-08T10:00:00Z")) * 1_000_000n + 123456789n}`);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["render.log_id"], "log-1");
  assert.equal(attrs["render.instance"], "srv-abc-xyz");
});

test("maps flat syslog-annotation-style fields and epoch timestamps", () => {
  const out = renderStreamLogsToOtlp([
    {
      message: "worker started",
      time: 1783936800123, // epoch ms
      level: "warning",
      service: "acme-worker",
      instance: "srv-def-1",
      deploy: "dep-42",
    },
  ]);
  const rl = at(out.resourceLogs, 0);
  const resourceAttrs = Object.fromEntries(
    rl.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "acme-worker");
  const record = at(at(rl.scopeLogs, 0).logRecords, 0);
  assert.equal(record.severityText, "WARN");
  assert.equal(record.timeUnixNano, `${1783936800123n * 1_000_000n}`);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["render.instance"], "srv-def-1");
  // Unknown scalar fields ride along instead of being dropped.
  assert.equal(attrs["render.attr.deploy"], "dep-42");
});

test("an unrecognized record still produces a usable log line", () => {
  const out = renderStreamLogsToOtlp([{ weird: true, nested: { a: 1 } }]);
  const rl = at(out.resourceLogs, 0);
  const resourceAttrs = Object.fromEntries(
    rl.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "render");
  const record = at(at(rl.scopeLogs, 0).logRecords, 0);
  // Whole record serialized as the body so nothing is lost.
  assert.match(record.body.stringValue ?? "", /weird/);
  assert.equal(record.timeUnixNano, "0");
});
