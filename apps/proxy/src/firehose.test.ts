import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  FIREHOSE_ACCESS_KEY_HEADER,
  FIREHOSE_REQUEST_ID_HEADER,
  FIREHOSE_SOURCE_ARN_HEADER,
  buildFirehoseUpstreamHeaders,
  firehoseResponseBody,
  parseAccountIdFromFirehoseArn,
} from "./firehose.js";

test("header constants are the lowercase AWS Firehose names", () => {
  // Hono header lookups are case-insensitive, but we keep these lowercase so the
  // values we set on the upstream request match what the collector receiver reads.
  assert.equal(FIREHOSE_ACCESS_KEY_HEADER, "x-amz-firehose-access-key");
  assert.equal(FIREHOSE_REQUEST_ID_HEADER, "x-amz-firehose-request-id");
  assert.equal(FIREHOSE_SOURCE_ARN_HEADER, "x-amz-firehose-source-arn");
});

test("parseAccountIdFromFirehoseArn extracts the 12-digit account id", () => {
  assert.equal(
    parseAccountIdFromFirehoseArn(
      "arn:aws:firehose:us-west-2:121638211609:deliverystream/superlog-metrics",
    ),
    "121638211609",
  );
  // Doc example region/account from the AWS spec.
  assert.equal(
    parseAccountIdFromFirehoseArn(
      "arn:aws:firehose:us-east-1:123456789012:deliverystream/testStream",
    ),
    "123456789012",
  );
});

test("parseAccountIdFromFirehoseArn returns null for missing/malformed ARNs", () => {
  assert.equal(parseAccountIdFromFirehoseArn(null), null);
  assert.equal(parseAccountIdFromFirehoseArn(undefined), null);
  assert.equal(parseAccountIdFromFirehoseArn(""), null);
  assert.equal(parseAccountIdFromFirehoseArn("not-an-arn"), null);
  // Wrong service in the ARN — don't trust an account id we can't attribute to Firehose.
  assert.equal(parseAccountIdFromFirehoseArn("arn:aws:s3:us-west-2:121638211609:bucket/x"), null);
});

test("buildFirehoseUpstreamHeaders stamps tenant + forwards the required request id", () => {
  const headers = buildFirehoseUpstreamHeaders({
    projectId: "proj-123",
    requestId: "req-abc",
    contentType: "application/json",
  });
  assert.ok(headers);
  assert.equal(headers["x-superlog-project-id"], "proj-123");
  // The awsfirehose receiver returns 400 "missing request id in header" without this.
  assert.equal(headers[FIREHOSE_REQUEST_ID_HEADER], "req-abc");
  assert.equal(headers["content-type"], "application/json");
});

test("buildFirehoseUpstreamHeaders forwards content-encoding only when present", () => {
  const gz = buildFirehoseUpstreamHeaders({
    projectId: "p",
    requestId: "r",
    contentType: "application/json",
    contentEncoding: "gzip",
  });
  assert.equal(gz?.["content-encoding"], "gzip");

  const plain = buildFirehoseUpstreamHeaders({
    projectId: "p",
    requestId: "r",
    contentType: "application/json",
  });
  assert.equal("content-encoding" in (plain ?? {}), false);
});

test("buildFirehoseUpstreamHeaders returns null when the request id is missing", () => {
  // No point forwarding to the receiver — it would 400. Caller fails fast instead.
  assert.equal(
    buildFirehoseUpstreamHeaders({
      projectId: "p",
      requestId: null,
      contentType: "application/json",
    }),
    null,
  );
});

test("firehoseResponseBody builds the Firehose success ack shape", () => {
  const body = firehoseResponseBody("req-abc");
  assert.equal(body.requestId, "req-abc");
  assert.equal(typeof body.timestamp, "number");
  assert.equal("errorMessage" in body, false);
});

test("firehoseResponseBody includes errorMessage for failures", () => {
  const body = firehoseResponseBody("req-abc", "invalid api key");
  assert.equal(body.requestId, "req-abc");
  assert.equal(body.errorMessage, "invalid api key");
  assert.equal(typeof body.timestamp, "number");
});
