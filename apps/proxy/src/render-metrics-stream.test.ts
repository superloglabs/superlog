import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { decodeOtlpMetricsPayload } from "./otlp-decode.js";
import { stampRenderStreamMetrics } from "./render-metrics-stream.js";

const require = createRequire(import.meta.url);
const otlpRoot = require("@opentelemetry/otlp-transformer/build/esm/generated/root.js");
const ExportMetricsServiceRequest =
  otlpRoot.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;

function samplePayload() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "fakeco-api" } }],
        },
        scopeMetrics: [
          {
            scope: { name: "render" },
            metrics: [
              {
                name: "render.cpu_usage",
                unit: "cpu",
                gauge: {
                  dataPoints: [{ timeUnixNano: "1750000000000000000", asDouble: 0.25 }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

test("stamps telemetry.source=render onto every resource", () => {
  const stamped = stampRenderStreamMetrics(samplePayload()) as ReturnType<typeof samplePayload>;
  const attrs = stamped.resourceMetrics[0]?.resource.attributes ?? [];
  assert.deepEqual(attrs, [
    { key: "service.name", value: { stringValue: "fakeco-api" } },
    { key: "telemetry.source", value: { stringValue: "render" } },
  ]);
});

test("replaces a spoofed telemetry.source instead of duplicating it", () => {
  const payload = samplePayload();
  payload.resourceMetrics[0]?.resource.attributes.push({
    key: "telemetry.source",
    value: { stringValue: "otlp" },
  });
  const stamped = stampRenderStreamMetrics(payload) as ReturnType<typeof samplePayload>;
  const sources = (stamped.resourceMetrics[0]?.resource.attributes ?? []).filter(
    (a) => a.key === "telemetry.source",
  );
  assert.deepEqual(sources, [{ key: "telemetry.source", value: { stringValue: "render" } }]);
});

test("stamps a resource-less entry rather than dropping it", () => {
  const payload = {
    resourceMetrics: [{ scopeMetrics: [] }],
  };
  const stamped = stampRenderStreamMetrics(payload) as {
    resourceMetrics: Array<{ resource?: { attributes?: unknown[] } }>;
  };
  assert.deepEqual(stamped.resourceMetrics[0]?.resource?.attributes, [
    { key: "telemetry.source", value: { stringValue: "render" } },
  ]);
});

test("strips exemplars so protobuf byte fields never reach the JSON forward", () => {
  const payload = samplePayload();
  const dp = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints[0] as
    | (Record<string, unknown> & { exemplars?: unknown })
    | undefined;
  if (dp) dp.exemplars = [{ spanId: Buffer.from("abc"), asDouble: 1 }];
  const stamped = stampRenderStreamMetrics(payload);
  assert.ok(!JSON.stringify(stamped).includes("exemplars"));
});

test("rejects a payload without resourceMetrics", () => {
  assert.throws(() => stampRenderStreamMetrics({ resourceLogs: [] }));
  assert.throws(() => stampRenderStreamMetrics("nope"));
});

test("decodes a gzipped protobuf OTLP export and stamps it", () => {
  const message = ExportMetricsServiceRequest.fromObject(samplePayload());
  const body = gzipSync(Buffer.from(ExportMetricsServiceRequest.encode(message).finish()));
  const decoded = decodeOtlpMetricsPayload({
    contentType: "application/x-protobuf",
    contentEncoding: "gzip",
    body,
  });
  const stamped = stampRenderStreamMetrics(decoded) as {
    resourceMetrics: Array<{
      resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
      scopeMetrics: Array<{
        metrics: Array<{
          gauge: { dataPoints: Array<{ timeUnixNano: string; asDouble: number }> };
        }>;
      }>;
    }>;
  };
  const attrs = stamped.resourceMetrics[0]?.resource.attributes ?? [];
  assert.ok(attrs.some((a) => a.key === "telemetry.source" && a.value.stringValue === "render"));
  assert.ok(attrs.some((a) => a.key === "service.name" && a.value.stringValue === "fakeco-api"));
  const point = stamped.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints[0];
  assert.equal(point?.timeUnixNano, "1750000000000000000");
  assert.equal(point?.asDouble, 0.25);
});

test("decodes a plain JSON export", () => {
  const decoded = decodeOtlpMetricsPayload({
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(samplePayload())),
  });
  assert.deepEqual(decoded, samplePayload());
});
