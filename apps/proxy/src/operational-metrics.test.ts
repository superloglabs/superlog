import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createProxyOperationalRecorder } from "./operational-metrics.js";

test("createProxyOperationalRecorder records ingest requests by org, project, signal, status, storage, and latency", () => {
  const requests: Array<{ value: number; attrs: Record<string, unknown> }> = [];
  const durations: Array<{ value: number; attrs: Record<string, unknown> }> = [];
  const bytes: Array<{ value: number; attrs: Record<string, unknown> }> = [];

  const recorder = createProxyOperationalRecorder({
    ingestRequests: { add: (value, attrs) => requests.push({ value, attrs: attrs ?? {} }) },
    ingestDurationMs: { record: (value, attrs) => durations.push({ value, attrs: attrs ?? {} }) },
    ingestRequestBytes: { record: (value, attrs) => bytes.push({ value, attrs: attrs ?? {} }) },
  });

  recorder.recordIngestRequest({
    path: "/v1/traces",
    projectId: "project_123",
    orgId: "org_123",
    orgName: "Acme",
    statusCode: 200,
    durationMs: 18,
    requestBytes: 2048,
    storage: "s3",
  });

  assert.deepEqual(requests, [
    {
      value: 1,
      attrs: {
        "otlp.signal": "traces",
        "tenant.project.id": "project_123",
        "tenant.org.id": "org_123",
        "tenant.org.name": "Acme",
        "http.response.status_code": 200,
        "http.response.status_class": "2xx",
        "ingest.queue.storage": "s3",
      },
    },
  ]);
  assert.deepEqual(durations, [{ value: 18, attrs: requests[0]?.attrs }]);
  assert.deepEqual(bytes, [{ value: 2048, attrs: requests[0]?.attrs }]);
});

test("createProxyOperationalRecorder records queue delivery failures with bounded cardinality attributes", () => {
  const messages: Array<{ value: number; attrs: Record<string, unknown> }> = [];
  const durations: Array<{ value: number; attrs: Record<string, unknown> }> = [];
  const ages: Array<{ value: number; attrs: Record<string, unknown> }> = [];

  const recorder = createProxyOperationalRecorder({
    queueMessages: { add: (value, attrs) => messages.push({ value, attrs: attrs ?? {} }) },
    queueDeliveryDurationMs: { record: (value, attrs) => durations.push({ value, attrs: attrs ?? {} }) },
    queueMessageAgeMs: { record: (value, attrs) => ages.push({ value, attrs: attrs ?? {} }) },
  });

  recorder.recordQueueDelivery({
    path: "/v1/logs",
    projectId: "project_123",
    storage: "inline",
    outcome: "collector_error",
    collectorStatusCode: 503,
    durationMs: 91,
    ageMs: 12_000,
  });

  assert.deepEqual(messages, [
    {
      value: 1,
      attrs: {
        "otlp.signal": "logs",
        "tenant.project.id": "project_123",
        "ingest.queue.storage": "inline",
        "ingest.queue.outcome": "collector_error",
        "collector.status_code": 503,
        "collector.status_class": "5xx",
      },
    },
  ]);
  assert.deepEqual(durations, [{ value: 91, attrs: messages[0]?.attrs }]);
  assert.deepEqual(ages, [{ value: 12_000, attrs: messages[0]?.attrs }]);
});

test("recordIngestRequest can emit without org enrichment", () => {
  const requests: Array<{ value: number; attrs: Record<string, unknown> }> = [];
  const recorder = createProxyOperationalRecorder({
    ingestRequests: { add: (value, attrs) => requests.push({ value, attrs: attrs ?? {} }) },
  });

  recorder.recordIngestRequest({
    path: "/v1/metrics",
    projectId: "project_123",
    statusCode: 500,
    durationMs: 5,
    requestBytes: 0,
    storage: "direct",
  });

  assert.deepEqual(requests, [
    {
      value: 1,
      attrs: {
        "otlp.signal": "metrics",
        "tenant.project.id": "project_123",
        "http.response.status_code": 500,
        "http.response.status_class": "5xx",
        "ingest.queue.storage": "direct",
      },
    },
  ]);
});
