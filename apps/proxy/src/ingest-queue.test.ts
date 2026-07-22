import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PoisonMessageError,
  SqsBatchEntryRejectedError,
  describeCollectorFailure,
  encodeIngestMessage,
  getIngestQueueConfig,
  ingestLaneForContentLength,
  isPermanentCollectorFailure,
  isPoisonMessageError,
  parseIngestMessage,
  queueDeliveryMetricFromParsedMessage,
  shouldCleanupOversizeObjectAfterQueueFailure,
} from "./ingest-queue.js";

const baseInput = {
  path: "/v1/logs",
  projectId: "project-1",
  contentType: "application/x-protobuf",
  body: Buffer.from("hello"),
};

test("getIngestQueueConfig leaves direct forwarding enabled by default", () => {
  assert.equal(getIngestQueueConfig({}), null);
});

test("getIngestQueueConfig reads bounded consumer concurrency", () => {
  const config = getIngestQueueConfig({
    INGEST_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123/superlog-test-ingest",
    INGEST_QUEUE_CONSUMER_CONCURRENCY: "99",
  });

  assert.equal(config?.consumerConcurrency, 32);
});

test("encodeIngestMessage stores small payloads inline", () => {
  const encoded = encodeIngestMessage(
    baseInput,
    {
      maxMessageBytes: 240_000,
      oversizePrefix: "otlp-oversize",
    },
    new Date("2026-05-24T00:00:00.000Z"),
    "payload-1",
  );

  assert.equal(encoded.storage, "inline");
  assert.equal(encoded.s3Object, undefined);

  const message = JSON.parse(encoded.messageBody);
  assert.equal(message.body.storage, "inline");
  assert.equal(Buffer.from(message.body.base64, "base64").toString("utf8"), "hello");
});

test("encodeIngestMessage offloads payloads that would exceed the SQS envelope budget", () => {
  const encoded = encodeIngestMessage(
    { ...baseInput, body: Buffer.alloc(32, 7), contentEncoding: "gzip" },
    {
      maxMessageBytes: 10,
      oversizeBucket: "superlog-ingest-oversize",
      oversizePrefix: "/otlp-oversize/",
    },
    new Date("2026-05-24T12:34:56.000Z"),
    "payload-2",
  );

  assert.equal(encoded.storage, "s3");
  assert.equal(encoded.s3Object?.bucket, "superlog-ingest-oversize");
  assert.equal(encoded.s3Object?.key, "otlp-oversize/2026/05/24/payload-2.otlp");
  assert.equal(encoded.s3Object?.body.byteLength, 32);

  const message = JSON.parse(encoded.messageBody);
  assert.equal(message.body.storage, "s3");
  assert.equal(message.body.bucket, "superlog-ingest-oversize");
  assert.equal(message.body.key, "otlp-oversize/2026/05/24/payload-2.otlp");
  assert.equal(message.contentEncoding, "gzip");
});

test("describeCollectorFailure includes bounded collector response body", () => {
  const failure = describeCollectorFailure(400, "bad request: invalid OTLP payload");

  assert.equal(failure.message, "collector returned 400: bad request: invalid OTLP payload");
  assert.equal(failure.status, 400);
  assert.equal(failure.body, "bad request: invalid OTLP payload");
});

test("isPermanentCollectorFailure drops 4xx the collector can never accept on retry", () => {
  // A real prod incident: a client sent http.response_content_length above uint64 max,
  // the collector 400s the whole batch, and the consumer cycled the same message every
  // 900s (visibility timeout) for ~12.5h before the DLQ — pinning oldest-message-age into
  // a sawtooth. Re-sending identical bytes can never succeed, so 4xx must be dropped.
  assert.equal(isPermanentCollectorFailure(400), true);
  assert.equal(isPermanentCollectorFailure(401), true);
  assert.equal(isPermanentCollectorFailure(403), true);
  assert.equal(isPermanentCollectorFailure(404), true);
  assert.equal(isPermanentCollectorFailure(413), true);
  assert.equal(isPermanentCollectorFailure(422), true);
});

test("isPermanentCollectorFailure keeps retryable statuses on the queue", () => {
  // 408/429 are backpressure/timeout signals and 5xx are transient — the same payload can
  // succeed once the collector recovers, so these stay in the queue for redelivery.
  assert.equal(isPermanentCollectorFailure(408), false);
  assert.equal(isPermanentCollectorFailure(429), false);
  assert.equal(isPermanentCollectorFailure(500), false);
  assert.equal(isPermanentCollectorFailure(502), false);
  assert.equal(isPermanentCollectorFailure(503), false);
  assert.equal(isPermanentCollectorFailure(504), false);
  // Not a failure status at all — defensively never treated as a permanent drop.
  assert.equal(isPermanentCollectorFailure(200), false);
});

test("parseIngestMessage round-trips a well-formed inline message", () => {
  const encoded = encodeIngestMessage(
    baseInput,
    { maxMessageBytes: 240_000, oversizePrefix: "otlp-oversize" },
    new Date("2026-05-24T00:00:00.000Z"),
    "payload-ok",
  );

  const parsed = parseIngestMessage(encoded.messageBody);
  assert.equal(parsed.path, "/v1/logs");
  assert.equal(parsed.body.storage, "inline");
});

test("parseIngestMessage flags an empty inline body as a poison message", () => {
  // An empty OTLP HTTP body base64-encodes to "" — there is nothing to forward and
  // no retry can ever succeed, so it must be classified as poison (delete, not cycle).
  const emptyBody = JSON.stringify({
    version: 1,
    kind: "otlp",
    path: "/v1/logs",
    projectId: "project-1",
    contentType: "application/json",
    receivedAt: "2026-05-29T00:00:00.000Z",
    body: { storage: "inline", base64: "" },
  });

  assert.throws(() => parseIngestMessage(emptyBody), PoisonMessageError);
  try {
    parseIngestMessage(emptyBody);
  } catch (err) {
    assert.equal(isPoisonMessageError(err), true);
  }
});

test("parseIngestMessage flags non-JSON message bodies as poison", () => {
  assert.throws(() => parseIngestMessage("not json at all"), PoisonMessageError);
});

test("parseIngestMessage flags valid JSON with malformed envelope fields as poison", () => {
  // Valid JSON, but `path` is a number — assertIngestMessage's `.startsWith` would throw a
  // TypeError. A structurally-broken envelope can never succeed on retry, so it must be poison.
  const malformed = JSON.stringify({
    version: 1,
    kind: "otlp",
    path: 123,
    projectId: "project-1",
    contentType: "application/json",
    body: { storage: "inline", base64: "aGVsbG8=" },
  });

  assert.throws(() => parseIngestMessage(malformed), PoisonMessageError);
});

test("isPoisonMessageError discriminates transient errors", () => {
  assert.equal(isPoisonMessageError(new Error("collector returned 503")), false);
  assert.equal(isPoisonMessageError(new PoisonMessageError("bad")), true);
});

test("ambiguous SQS send failures preserve the oversize object", () => {
  assert.equal(shouldCleanupOversizeObjectAfterQueueFailure(new Error("request timed out")), false);
});

test("definitive SQS batch entry rejections clean up the oversize object", () => {
  assert.equal(
    shouldCleanupOversizeObjectAfterQueueFailure(
      new SqsBatchEntryRejectedError("InvalidMessageContents", "invalid body"),
    ),
    true,
  );
});

test("queueDeliveryMetricFromParsedMessage ignores malformed parsed payloads", () => {
  assert.equal(
    queueDeliveryMetricFromParsedMessage(
      { path: "/v1/logs", projectId: "project-1", body: {} },
      "delivery_error",
      undefined,
      12,
      34,
    ),
    null,
  );
});

// Lane routing: small requests buffer-and-inline (the fast lane); only bodies
// over the inline threshold stream to S3 (the slow, multi-second upload lane).
// Routing on Content-Length keeps a slow oversize upload from head-of-line
// blocking a tiny request behind the same admission permit.
test("ingestLaneForContentLength routes by the inline threshold", () => {
  const threshold = 175_000;
  // A body at or under the threshold buffers inline → fast lane.
  assert.equal(ingestLaneForContentLength(0, threshold), "buffer");
  assert.equal(ingestLaneForContentLength(1, threshold), "buffer");
  assert.equal(ingestLaneForContentLength(threshold, threshold), "buffer");
  // Strictly over the threshold spills to S3 → upload lane.
  assert.equal(ingestLaneForContentLength(threshold + 1, threshold), "upload");
  assert.equal(ingestLaneForContentLength(40 * 1024 * 1024, threshold), "upload");
});

test("ingestLaneForContentLength defaults to the buffer lane when size is unknown or invalid", () => {
  const threshold = 175_000;
  // No Content-Length header (chunked) → buffer lane; captureBody promotes to a
  // spill if it actually crosses the threshold while streaming.
  assert.equal(ingestLaneForContentLength(undefined, threshold), "buffer");
  assert.equal(ingestLaneForContentLength(Number.NaN, threshold), "buffer");
  assert.equal(ingestLaneForContentLength(-1, threshold), "buffer");
});

test("getIngestQueueConfig reads bounded S3/SQS socket pools", () => {
  const base = { INGEST_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123/superlog-test-ingest" };

  // Defaults: the S3 pool is generous enough that oversize uploads don't queue
  // at the socket layer below the upload-lane permit cap.
  const defaults = getIngestQueueConfig(base);
  assert.equal(defaults?.s3MaxSockets, 128);
  assert.equal(defaults?.sqsMaxSockets, 64);

  // Overridable via env.
  const tuned = getIngestQueueConfig({
    ...base,
    INGEST_S3_MAX_SOCKETS: "256",
    INGEST_SQS_MAX_SOCKETS: "96",
  });
  assert.equal(tuned?.s3MaxSockets, 256);
  assert.equal(tuned?.sqsMaxSockets, 96);
});
