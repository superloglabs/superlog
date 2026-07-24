import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  advanceLogCursor,
  advanceMetricsCursor,
  filterLogsAfterCursor,
  filterMetricsAfterCursor,
  railwayLogsToOtlp,
  railwayMetricsToOtlp,
  rfc3339ToNanos,
} from "./transform.js";

// Index into an array with narrowing (strict indexing forbids bare [0]).
function at<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  assert.ok(item !== undefined, `expected item at index ${index}`);
  return item;
}

const NAMES = {
  serviceNamesById: { "svc-1": "blackbird-app" },
  projectName: "blackbird",
  projectId: "proj-1",
  environmentName: "production",
  environmentId: "env-1",
};

const LOG = {
  timestamp: "2026-07-07T14:10:31.058154105Z",
  severity: "info",
  message: "--> GET / \u001b[32m200\u001b[0m 1ms",
  tags: {
    projectId: "proj-1",
    environmentId: "env-1",
    serviceId: "svc-1",
    deploymentId: "dep-1",
    deploymentInstanceId: "inst-1",
    snapshotId: null,
  },
  attributes: [{ key: "level", value: "info" }],
};

test("rfc3339ToNanos keeps sub-millisecond precision", () => {
  assert.equal(rfc3339ToNanos("2026-07-07T14:10:31.058154105Z"), 1783433431058154105n);
  assert.equal(rfc3339ToNanos("2026-07-07T14:10:31Z"), 1783433431000000000n);
  assert.equal(rfc3339ToNanos("garbage"), null);
});

test("railwayLogsToOtlp maps a Railway log line to an OTLP log record", () => {
  const out = railwayLogsToOtlp([LOG], NAMES);
  assert.equal(out.resourceLogs.length, 1);
  const rl = at(out.resourceLogs, 0);
  const resourceAttrs = Object.fromEntries(
    rl.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "blackbird-app");
  assert.equal(resourceAttrs["telemetry.source"], "railway");
  assert.equal(resourceAttrs["railway.project_name"], "blackbird");
  assert.equal(resourceAttrs["railway.environment_name"], "production");

  const record = at(at(rl.scopeLogs, 0).logRecords, 0);
  assert.equal(record.timeUnixNano, "1783433431058154105");
  assert.equal(record.severityText, "INFO");
  assert.equal(record.severityNumber, 9);
  // ANSI escapes are stripped from the body.
  assert.equal(record.body.stringValue, "--> GET / 200 1ms");
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["railway.deployment_id"], "dep-1");
});

test("railwayLogsToOtlp uses native logfmt fields instead of Railway's stderr severity", () => {
  const message =
    'time="2026-07-22T13:57:21.842594391Z" level=info msg="loading plugin" id=io.containerd.grpc.v1.healthcheck type=io.containerd.grpc.v1';
  const out = railwayLogsToOtlp(
    [
      {
        ...LOG,
        severity: "error",
        message,
        attributes: [{ key: "level", value: '"error"' }],
      },
    ],
    NAMES,
  );

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "loading plugin");
  assert.equal(record.severityText, "INFO");
  assert.equal(record.severityNumber, 9);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["railway.log.format"], "logfmt");
  assert.equal(attrs["railway.log.level"], "info");
  assert.equal(attrs["railway.log.id"], "io.containerd.grpc.v1.healthcheck");
  assert.equal(attrs["railway.log.type"], "io.containerd.grpc.v1");
  assert.equal(attrs["railway.log.provider_severity"], "error");
  assert.equal(attrs["railway.log.severity_source"], "logfmt");
  assert.equal(attrs["log.record.original"], message);
});

test("railwayLogsToOtlp maps PostgreSQL LOG records to informational structured logs", () => {
  const message =
    "2026-07-24 09:24:40.055 UTC [59] LOG:  checkpoint complete: wrote 1114 buffers (6.8%)";
  const out = railwayLogsToOtlp([{ ...LOG, severity: "error", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "checkpoint complete: wrote 1114 buffers (6.8%)");
  assert.equal(record.severityText, "INFO");
  assert.equal(record.severityNumber, 9);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["railway.log.format"], "postgresql");
  assert.equal(attrs["railway.log.level"], "LOG");
  assert.equal(attrs["railway.log.timestamp"], "2026-07-24 09:24:40.055 UTC");
  assert.equal(attrs["railway.log.pid"], "59");
  assert.equal(attrs["railway.log.provider_severity"], "error");
  assert.equal(attrs["railway.log.severity_source"], "postgresql");
  assert.equal(attrs["log.record.original"], message);
});

test("railwayLogsToOtlp preserves PostgreSQL warning severity and connection fields", () => {
  const message =
    "2026-07-24 16:42:04.651 UTC [1386] app@railway WARNING:  there is no transaction in progress";
  const out = railwayLogsToOtlp([{ ...LOG, severity: "error", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "there is no transaction in progress");
  assert.equal(record.severityText, "WARN");
  assert.equal(record.severityNumber, 13);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["railway.log.level"], "WARNING");
  assert.equal(attrs["railway.log.user"], "app");
  assert.equal(attrs["railway.log.database"], "railway");
});

test("railwayLogsToOtlp preserves scalar fields from structured JSON logs", () => {
  const message = JSON.stringify({
    level: "warn",
    message: "queue depth high",
    job: "emails",
    attempt: 3,
    healthy: false,
    nested: { ignored: true },
  });
  const out = railwayLogsToOtlp([{ ...LOG, severity: "error", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "queue depth high");
  assert.equal(record.severityText, "WARN");
  assert.equal(record.severityNumber, 13);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
  assert.equal(attrs["railway.log.format"]?.stringValue, "json");
  assert.equal(attrs["railway.log.level"]?.stringValue, "warn");
  assert.equal(attrs["railway.log.job"]?.stringValue, "emails");
  assert.equal(attrs["railway.log.attempt"]?.intValue, "3");
  assert.equal(attrs["railway.log.healthy"]?.boolValue, false);
  assert.equal(attrs["railway.log.nested"], undefined);
  assert.equal(attrs["railway.log.provider_severity"]?.stringValue, "error");
  assert.equal(attrs["railway.log.severity_source"]?.stringValue, "json");
  assert.equal(attrs["log.record.original"]?.stringValue, message);
});

test("railwayLogsToOtlp decodes Railway's JSON-encoded scalar attributes", () => {
  const out = railwayLogsToOtlp(
    [
      {
        ...LOG,
        attributes: [
          { key: "level", value: '"info"' },
          { key: "attempt", value: "3" },
          { key: "healthy", value: "false" },
          { key: "metadata", value: '{"nested":true}' },
        ],
      },
    ],
    NAMES,
  );

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
  assert.equal(attrs["railway.attr.level"]?.stringValue, "info");
  assert.equal(attrs["railway.attr.attempt"]?.intValue, "3");
  assert.equal(attrs["railway.attr.healthy"]?.boolValue, false);
  assert.equal(attrs["railway.attr.metadata"]?.stringValue, '{"nested":true}');
});

test("railwayLogsToOtlp maps successful common access logs to structured HTTP info", () => {
  const message =
    '100.64.0.6 - - [2026-07-22 20:25:33] "POST /v1/audio/speech HTTP/1.1" 200 10761 1.317203';
  const out = railwayLogsToOtlp([{ ...LOG, severity: "error", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "POST /v1/audio/speech 200");
  assert.equal(record.severityText, "INFO");
  assert.equal(record.severityNumber, 9);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
  assert.equal(attrs["railway.log.format"]?.stringValue, "http_access");
  assert.equal(attrs["network.peer.address"]?.stringValue, "100.64.0.6");
  assert.equal(attrs["railway.log.timestamp"]?.stringValue, "2026-07-22 20:25:33");
  assert.equal(attrs["http.request.method"]?.stringValue, "POST");
  assert.equal(attrs["url.path"]?.stringValue, "/v1/audio/speech");
  assert.equal(attrs["network.protocol.name"]?.stringValue, "http");
  assert.equal(attrs["network.protocol.version"]?.stringValue, "1.1");
  assert.equal(attrs["http.response.status_code"]?.intValue, "200");
  assert.equal(attrs["http.response.body.size"]?.intValue, "10761");
  assert.equal(attrs["railway.log.duration_seconds"]?.doubleValue, 1.317203);
  assert.equal(attrs["railway.log.provider_severity"]?.stringValue, "error");
  assert.equal(attrs["railway.log.severity_source"]?.stringValue, "http_status");
  assert.equal(attrs["log.record.original"]?.stringValue, message);
});

test("railwayLogsToOtlp keeps HTTP server failures at error severity", () => {
  const message = '100.64.0.6 - - [2026-07-22 20:25:33] "GET /health HTTP/1.1" 503 19 0.012';
  const out = railwayLogsToOtlp([{ ...LOG, severity: "info", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "GET /health 503");
  assert.equal(record.severityText, "ERROR");
  assert.equal(record.severityNumber, 17);
});

test("railwayLogsToOtlp keeps Railway severity when a parsed native level is unknown", () => {
  const message = 'level=verbose msg="something happened" request_id=req-1';
  const out = railwayLogsToOtlp([{ ...LOG, severity: "error", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "something happened");
  assert.equal(record.severityText, "ERROR");
  assert.equal(record.severityNumber, 17);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["railway.log.level"], "verbose");
  assert.equal(attrs["railway.log.provider_severity"], "error");
  assert.equal(attrs["railway.log.severity_source"], "railway");
});

test("railwayLogsToOtlp structures logfmt without a native level", () => {
  const message = 'msg="request finished" request_id=req-1';
  const out = railwayLogsToOtlp([{ ...LOG, severity: "warning", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "request finished");
  assert.equal(record.severityText, "WARN");
  assert.equal(record.severityNumber, 13);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["railway.log.format"], "logfmt");
  assert.equal(attrs["railway.log.request_id"], "req-1");
  assert.equal(attrs["railway.log.severity_source"], "railway");
  assert.equal(attrs["log.record.original"], message);
});

test("railwayLogsToOtlp parses escaped logfmt values", () => {
  const message = 'level=info msg="worker said \\"ready\\" at C:\\\\jobs" request_id=req-1';
  const out = railwayLogsToOtlp([{ ...LOG, severity: "error", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, 'worker said "ready" at C:\\jobs');
  assert.equal(record.severityText, "INFO");
});

test("railwayLogsToOtlp safely rejects a long unterminated logfmt value", () => {
  const message = `level=info msg="${"\\!".repeat(10_000)}`;
  const out = railwayLogsToOtlp([{ ...LOG, severity: "error", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, message);
  assert.equal(record.severityText, "ERROR");
});

test("railwayLogsToOtlp bounds extracted structured attributes", () => {
  const longKey = "x".repeat(129);
  const message = JSON.stringify({
    level: "info",
    message: "bounded fields",
    accepted: "yes",
    oversized: "x".repeat(4097),
    [longKey]: "too long",
  });
  const out = railwayLogsToOtlp([{ ...LOG, message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
  assert.equal(attrs["railway.log.accepted"]?.stringValue, "yes");
  assert.equal(attrs["railway.log.oversized"], undefined);
  assert.equal(attrs[`railway.log.${longKey}`], undefined);
});

test("railwayLogsToOtlp leaves malformed structured messages lossless", () => {
  const message = 'level=info msg="unterminated';
  const out = railwayLogsToOtlp([{ ...LOG, severity: "error", message }], NAMES);

  const record = at(at(at(out.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, message);
  assert.equal(record.severityText, "ERROR");
  assert.equal(record.severityNumber, 17);
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["railway.log.format"], undefined);
  assert.equal(attrs["log.record.original"], undefined);
});

test("railwayLogsToOtlp falls back to a railway service name when unmapped", () => {
  const out = railwayLogsToOtlp(
    [{ ...LOG, tags: { ...LOG.tags, serviceId: "unknown-svc" } }],
    NAMES,
  );
  const attrs = Object.fromEntries(
    at(out.resourceLogs, 0).resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(attrs["service.name"], "railway");
});

test("log cursor advances to the max timestamp and filters replays", () => {
  const older = { ...LOG, timestamp: "2026-07-07T14:10:30Z" };
  const cursor = advanceLogCursor({}, "env-1", [older, LOG]);
  assert.equal(cursor["env-1"], "2026-07-07T14:10:31.058154105Z");

  // Re-delivery of already-forwarded lines is dropped.
  const fresh = filterLogsAfterCursor(cursor, "env-1", [older, LOG]);
  assert.equal(fresh.length, 0);
  const newer = { ...LOG, timestamp: "2026-07-07T14:10:32Z" };
  assert.deepEqual(filterLogsAfterCursor(cursor, "env-1", [older, newer]), [newer]);
  // A cursor never moves backwards.
  const stale = advanceLogCursor(cursor, "env-1", [older]);
  assert.equal(stale["env-1"], "2026-07-07T14:10:31.058154105Z");
});

test("railwayMetricsToOtlp maps measurements to gauges with railway names", () => {
  const out = railwayMetricsToOtlp(
    [
      {
        measurement: "CPU_USAGE",
        values: [{ ts: 1783436400, value: 0.25 }],
        tags: { serviceId: "svc-1" },
      },
      {
        measurement: "MEMORY_USAGE_GB",
        values: [{ ts: 1783436400, value: 0.135 }],
        tags: { serviceId: "svc-1" },
      },
    ],
    NAMES,
  );
  assert.equal(out.resourceMetrics.length, 1);
  const rm = at(out.resourceMetrics, 0);
  const resourceAttrs = Object.fromEntries(
    rm.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "blackbird-app");
  assert.equal(resourceAttrs["telemetry.source"], "railway");

  const metrics = at(rm.scopeMetrics, 0).metrics;
  assert.deepEqual(
    metrics.map((m) => m.name),
    ["railway.cpu.usage", "railway.memory.usage"],
  );
  const cpu = at(metrics, 0);
  assert.equal(cpu.unit, "{vCPU}");
  assert.equal(at(cpu.gauge.dataPoints, 0).timeUnixNano, "1783436400000000000");
  assert.equal(at(cpu.gauge.dataPoints, 0).asDouble, 0.25);
});

test("metrics cursor drops already-forwarded samples per service", () => {
  const results = [
    {
      measurement: "CPU_USAGE",
      values: [
        { ts: 100, value: 1 },
        { ts: 200, value: 2 },
      ],
      tags: { serviceId: "svc-1" },
    },
  ];
  const filtered = filterMetricsAfterCursor({ "svc-1": 100 }, "svc-1", results);
  assert.deepEqual(at(filtered, 0).values, [{ ts: 200, value: 2 }]);

  const cursor = advanceMetricsCursor({ "svc-1": 100 }, "svc-1", results);
  assert.equal(cursor["svc-1"], 200);
  // Empty results keep the cursor untouched.
  assert.equal(advanceMetricsCursor(cursor, "svc-1", [])["svc-1"], 200);
});
