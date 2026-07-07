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
  const rl = out.resourceLogs[0]!;
  const resourceAttrs = Object.fromEntries(
    rl.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "blackbird-app");
  assert.equal(resourceAttrs["telemetry.source"], "railway");
  assert.equal(resourceAttrs["railway.project_name"], "blackbird");
  assert.equal(resourceAttrs["railway.environment_name"], "production");

  const record = rl.scopeLogs[0]!.logRecords[0]!;
  assert.equal(record.timeUnixNano, "1783433431058154105");
  assert.equal(record.severityText, "INFO");
  assert.equal(record.severityNumber, 9);
  // ANSI escapes are stripped from the body.
  assert.equal(record.body.stringValue, "--> GET / 200 1ms");
  const attrs = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(attrs["railway.deployment_id"], "dep-1");
});

test("railwayLogsToOtlp falls back to a railway service name when unmapped", () => {
  const out = railwayLogsToOtlp(
    [{ ...LOG, tags: { ...LOG.tags, serviceId: "unknown-svc" } }],
    NAMES,
  );
  const attrs = Object.fromEntries(
    out.resourceLogs[0]!.resource.attributes.map((a) => [a.key, a.value.stringValue]),
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
  const rm = out.resourceMetrics[0]!;
  const resourceAttrs = Object.fromEntries(
    rm.resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resourceAttrs["service.name"], "blackbird-app");
  assert.equal(resourceAttrs["telemetry.source"], "railway");

  const metrics = rm.scopeMetrics[0]!.metrics;
  assert.deepEqual(
    metrics.map((m) => m.name),
    ["railway.cpu.usage", "railway.memory.usage"],
  );
  const cpu = metrics[0]!;
  assert.equal(cpu.unit, "{vCPU}");
  assert.equal(cpu.gauge.dataPoints[0]!.timeUnixNano, "1783436400000000000");
  assert.equal(cpu.gauge.dataPoints[0]!.asDouble, 0.25);
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
  assert.deepEqual(filtered[0]!.values, [{ ts: 200, value: 2 }]);

  const cursor = advanceMetricsCursor({ "svc-1": 100 }, "svc-1", results);
  assert.equal(cursor["svc-1"], 200);
  // Empty results keep the cursor untouched.
  assert.equal(advanceMetricsCursor(cursor, "svc-1", [])["svc-1"], 200);
});
