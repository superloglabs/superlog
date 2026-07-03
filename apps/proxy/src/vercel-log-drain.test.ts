import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  parseVercelLogDrainBody,
  vercelLogsToOtlp,
} from "./vercel-log-drain.js";
import { otlpLogsToRows } from "./otlp-clickhouse.js";

const vercelLogs = [
  {
    id: "1573817250283254651097202070",
    deploymentId: "dpl_233NRGRjVZX1caZrXWtz5g1TAksD",
    source: "lambda",
    host: "my-app-abc123.vercel.app",
    timestamp: 1573817250283,
    projectId: "gdufoJxB6b9b1fEqr1jUtFkyavUU",
    level: "error",
    message: "API request failed",
    entrypoint: "api/index.js",
    requestId: "643af4e3-975a-4cc7-9e7a-1eda11539d90",
    statusCode: 500,
    path: "/api/users",
    executionRegion: "sfo1",
    environment: "production",
    projectName: "my-app",
    traceId: "1b02cd14bb8642fd092bc23f54c7ffcd",
    spanId: "f24e8631bd11faa7",
    proxy: {
      method: "GET",
      path: "/api/users?page=1",
      statusCode: 500,
      userAgent: ["Mozilla/5.0"],
    },
  },
];

test("parseVercelLogDrainBody accepts JSON arrays", () => {
  assert.deepEqual(
    parseVercelLogDrainBody(Buffer.from(JSON.stringify(vercelLogs)), "application/json"),
    vercelLogs,
  );
});

test("parseVercelLogDrainBody accepts NDJSON batches", () => {
  const body = Buffer.from(vercelLogs.map((log) => JSON.stringify(log)).join("\n"));
  assert.deepEqual(parseVercelLogDrainBody(body, "application/x-ndjson"), vercelLogs);
});

test("vercelLogsToOtlp maps Vercel logs to OTLP JSON logs", () => {
  const payload = vercelLogsToOtlp(vercelLogs);
  assert.equal(payload.resourceLogs?.length, 1);
  const record = payload.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0];
  assert.ok(record);
  assert.equal(record.body?.stringValue, "API request failed");
  assert.equal(record.severityText, "ERROR");
  assert.equal(record.severityNumber, 17);
  assert.equal(record.timeUnixNano, "1573817250283000000");
  assert.equal(record.traceId, "1b02cd14bb8642fd092bc23f54c7ffcd");
  assert.equal(record.spanId, "f24e8631bd11faa7");

  const attrs = Object.fromEntries(
    (record.attributes ?? []).map((kv) => [kv.key, kv.value?.stringValue ?? kv.value?.intValue]),
  );
  assert.equal(attrs["vercel.source"], "lambda");
  assert.equal(attrs["vercel.request_id"], "643af4e3-975a-4cc7-9e7a-1eda11539d90");
  assert.equal(attrs["http.response.status_code"], "500");
  assert.equal(attrs["vercel.proxy.path"], "/api/users?page=1");
  assert.equal(attrs["vercel.proxy.user_agent"], '["Mozilla/5.0"]');
});

test("mapped Vercel logs become ClickHouse log rows with service and tenant attributes", () => {
  const rows = otlpLogsToRows(vercelLogsToOtlp(vercelLogs), "superlog-project");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.ServiceName, "my-app");
  assert.equal(row.Body, "API request failed");
  assert.equal(row.ResourceAttributes["superlog.project_id"], "superlog-project");
  assert.equal(row.ResourceAttributes["service.name"], "my-app");
  assert.equal(row.ResourceAttributes["vercel.project_id"], "gdufoJxB6b9b1fEqr1jUtFkyavUU");
  assert.equal(row.LogAttributes["vercel.deployment_id"], "dpl_233NRGRjVZX1caZrXWtz5g1TAksD");
});
