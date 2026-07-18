import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  MAX_FINGERPRINT_BODY_BYTES,
  stampIssueFingerprints,
  stampIssueFingerprintsFailOpen,
  stampIssueFingerprintsWithinLimit,
} from "./ingest-fingerprints.js";

function captureLogger() {
  const calls: { level: "info" | "warn"; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    calls,
    info: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "info", obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => calls.push({ level: "warn", obj, msg }),
  };
}

const require = createRequire(import.meta.url);
const otlpRoot = require("@opentelemetry/otlp-transformer/build/esm/generated/root.js");
const ExportTraceServiceRequest =
  otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

test("stampIssueFingerprints adds issue fingerprint attributes to JSON trace exceptions", () => {
  const input = {
    path: "/v1/traces",
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    events: [
                      {
                        name: "exception",
                        attributes: [
                          { key: "exception.type", value: { stringValue: "Error" } },
                          { key: "exception.message", value: { stringValue: "boom 123" } },
                          {
                            key: "exception.stacktrace",
                            value: {
                              stringValue: "Error: boom\n    at fail (apps/api/src/foo.ts:10:2)",
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  };

  const stamped = stampIssueFingerprints(input);
  const payload = JSON.parse(stamped.body.toString("utf8"));
  const attributes = payload.resourceSpans[0].scopeSpans[0].spans[0].events[0].attributes;

  assert.equal(stamped.stampedCount, 1);
  assert.equal(
    attributes.find((attr: { key: string }) => attr.key === "superlog.issue_fingerprint").value
      .stringValue.length,
    16,
  );
});

test("stampIssueFingerprints adds issue fingerprint attributes to JSON error logs", () => {
  const input = {
    path: "/v1/logs",
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "superlog-api" } }],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    severityText: "ERROR",
                    body: { stringValue: "request failed for project 123" },
                    attributes: [
                      { key: "exception.type", value: { stringValue: "ForbiddenError" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  };

  const stamped = stampIssueFingerprints(input);
  const payload = JSON.parse(stamped.body.toString("utf8"));
  const attributes = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

  assert.equal(stamped.stampedCount, 1);
  assert.equal(
    attributes.find((attr: { key: string }) => attr.key === "superlog.issue_fingerprint").value
      .stringValue.length,
    16,
  );
});

test("stampIssueFingerprints adds issue fingerprint attributes to protobuf trace exceptions", () => {
  const request = ExportTraceServiceRequest.create({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                events: [
                  {
                    name: "exception",
                    attributes: [
                      { key: "exception.type", value: { stringValue: "Error" } },
                      { key: "exception.message", value: { stringValue: "boom 123" } },
                      {
                        key: "exception.stacktrace",
                        value: {
                          stringValue: "Error: boom\n    at fail (apps/api/src/foo.ts:10:2)",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const body = Buffer.from(ExportTraceServiceRequest.encode(request).finish());

  const stamped = stampIssueFingerprints({
    path: "/v1/traces",
    contentType: "application/x-protobuf",
    body,
  });
  const decoded = ExportTraceServiceRequest.decode(stamped.body);
  const attributes = decoded.resourceSpans[0].scopeSpans[0].spans[0].events[0].attributes;

  assert.equal(stamped.stampedCount, 1);
  assert.equal(
    attributes.find((attr: { key: string }) => attr.key === "superlog.issue_fingerprint").value
      .stringValue.length,
    16,
  );
});

test("stampIssueFingerprintsWithinLimit skips bodies over the limit without parsing them", () => {
  // An oversized body must never reach JSON.parse — that synchronous parse of a multi-MB
  // payload is what spikes RSS and OOM-kills the process. Feed deliberately invalid JSON
  // that exceeds the limit: if the guard parsed it, this would throw.
  const oversized = Buffer.from(`{not valid json${"x".repeat(64)}`);
  const stamped = stampIssueFingerprintsWithinLimit(
    { path: "/v1/logs", contentType: "application/json", body: oversized },
    32,
  );

  assert.equal(stamped.body, oversized);
  assert.equal(stamped.stampedCount, 0);
});

test("stampIssueFingerprintsWithinLimit stamps bodies within the limit", () => {
  const body = Buffer.from(
    JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  severityText: "ERROR",
                  body: { stringValue: "boom" },
                  attributes: [{ key: "exception.type", value: { stringValue: "Error" } }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );

  const stamped = stampIssueFingerprintsWithinLimit({
    path: "/v1/logs",
    contentType: "application/json",
    body,
  });

  assert.equal(stamped.stampedCount, 1);
  assert.ok(MAX_FINGERPRINT_BODY_BYTES > 0);
});

test("stampIssueFingerprintsFailOpen forwards the original body when stamping throws", () => {
  // Malformed JSON makes stampIssueFingerprints throw; the consumer must still forward the
  // payload verbatim rather than dropping it.
  const body = Buffer.from('{"resourceLogs": broken');
  const logger = captureLogger();

  const result = stampIssueFingerprintsFailOpen(
    { path: "/v1/logs", contentType: "application/json", body, projectId: "p1" },
    logger,
  );

  assert.equal(result, body);
  assert.equal(logger.calls.some((c) => c.level === "warn"), true);
});

test("stampIssueFingerprintsFailOpen returns the stamped body and logs on success", () => {
  const body = Buffer.from(
    JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  severityText: "ERROR",
                  body: { stringValue: "boom" },
                  attributes: [{ key: "exception.type", value: { stringValue: "Error" } }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const logger = captureLogger();

  const result = stampIssueFingerprintsFailOpen(
    { path: "/v1/logs", contentType: "application/json", body, projectId: "p1" },
    logger,
  );

  const stamped = JSON.parse(result.toString("utf8"));
  const attrs = stamped.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  assert.ok(attrs.find((a: { key: string }) => a.key === "superlog.issue_fingerprint"));
  assert.equal(logger.calls.some((c) => c.level === "info"), true);
});

test("stampIssueFingerprints leaves compressed payloads untouched", () => {
  const body = Buffer.from("compressed");
  const stamped = stampIssueFingerprints({
    path: "/v1/traces",
    contentType: "application/json",
    contentEncoding: "gzip",
    body,
  });

  assert.equal(stamped.body, body);
  assert.equal(stamped.stampedCount, 0);
});

test("stampIssueFingerprints strips client-supplied fingerprint from non-error logs even if no logs stamped", () => {
  const input = {
    path: "/v1/logs",
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    severityText: "INFO",
                    body: { stringValue: "info message" },
                    attributes: [
                      { key: "superlog.issue_fingerprint", value: { stringValue: "fakefp" } },
                      { key: "env", value: { stringValue: "prod" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  };

  const stamped = stampIssueFingerprints(input);
  assert.equal(stamped.stampedCount, 0);
  const payload = JSON.parse(stamped.body.toString("utf8"));
  const attributes = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  assert.equal(
    attributes.find((attr: { key: string }) => attr.key === "superlog.issue_fingerprint"),
    undefined,
  );
  assert.equal(
    attributes.find((attr: { key: string }) => attr.key === "env").value.stringValue,
    "prod",
  );
});

test("stampIssueFingerprints strips client-supplied fingerprint from non-exception trace events even if no spans stamped", () => {
  const input = {
    path: "/v1/traces",
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    events: [
                      {
                        name: "custom_event",
                        attributes: [
                          { key: "superlog.issue_fingerprint", value: { stringValue: "fakefp" } },
                          { key: "custom.key", value: { stringValue: "value" } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ),
  };

  const stamped = stampIssueFingerprints(input);
  assert.equal(stamped.stampedCount, 0);
  const payload = JSON.parse(stamped.body.toString("utf8"));
  const attributes = payload.resourceSpans[0].scopeSpans[0].spans[0].events[0].attributes;
  assert.equal(
    attributes.find((attr: { key: string }) => attr.key === "superlog.issue_fingerprint"),
    undefined,
  );
  assert.equal(
    attributes.find((attr: { key: string }) => attr.key === "custom.key").value.stringValue,
    "value",
  );
});
