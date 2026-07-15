import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  acknowledgeGcpPubSubDelivery,
  authenticateGcpPubSubPush,
  gcpPubSubLogToOtlp,
  resolveGcpPubSubPushAudience,
} from "./gcp-pubsub.js";
import { otlpLogsToRows } from "./otlp-clickhouse.js";

test("the Pub/Sub verifier defaults its audience to the configured push endpoint", () => {
  assert.equal(
    resolveGcpPubSubPushAudience({
      GCP_PUBSUB_PUSH_ENDPOINT: "https://intake.example.com/gcp/pubsub",
    }),
    "https://intake.example.com/gcp/pubsub",
  );
  assert.equal(
    resolveGcpPubSubPushAudience({
      GCP_PUBSUB_PUSH_ENDPOINT: "https://intake.example.com/gcp/pubsub",
      GCP_PUBSUB_PUSH_AUDIENCE: "https://audience.example.com/gcp",
    }),
    "https://audience.example.com/gcp",
  );
});

test("Pub/Sub acknowledges permanent ingest rejects but preserves retryable failures", () => {
  for (const status of [400, 402, 413]) {
    const permanentDrop = acknowledgeGcpPubSubDelivery(new Response("rejected", { status }));
    assert.equal(permanentDrop.status, 204);
    assert.equal(permanentDrop.headers.get("x-superlog-pubsub-drop"), String(status));
  }

  const retryable = new Response("collector unavailable", { status: 503 });
  assert.equal(acknowledgeGcpPubSubDelivery(retryable), retryable);

  const throttled = new Response("collector throttled", { status: 429 });
  assert.equal(acknowledgeGcpPubSubDelivery(throttled), throttled);
});

test("Pub/Sub push authentication requires the configured audience and service account", async () => {
  const seen: Array<{ idToken: string; audience: string }> = [];
  const verifier = {
    async verify(input: { idToken: string; audience: string }) {
      seen.push(input);
      return { email: "push@superlog-observability.iam.gserviceaccount.com", emailVerified: true };
    },
  };
  await authenticateGcpPubSubPush({
    authorization: "Bearer signed-google-id-token",
    audience: "https://intake.example.com/gcp/pubsub",
    serviceAccountEmail: "push@superlog-observability.iam.gserviceaccount.com",
    verifier,
  });
  assert.deepEqual(seen, [
    {
      idToken: "signed-google-id-token",
      audience: "https://intake.example.com/gcp/pubsub",
    },
  ]);

  await assert.rejects(
    authenticateGcpPubSubPush({
      authorization: "Bearer signed-google-id-token",
      audience: "https://intake.example.com/gcp/pubsub",
      serviceAccountEmail: "different@superlog-observability.iam.gserviceaccount.com",
      verifier,
    }),
    /unexpected service account/,
  );
});

test("a Cloud Logging Pub/Sub push becomes a tenant-safe OTLP log", () => {
  const entry = {
    insertId: "abc-123",
    logName: "projects/acme-production/logs/run.googleapis.com%2Fstdout",
    resource: {
      type: "cloud_run_revision",
      labels: {
        project_id: "acme-production",
        service_name: "checkout-api",
        location: "us-central1",
        revision_name: "checkout-api-00042",
      },
    },
    timestamp: "2026-07-13T10:15:30.123456Z",
    receiveTimestamp: "2026-07-13T10:15:31.000000Z",
    severity: "ERROR",
    textPayload: "checkout failed",
    trace: "projects/acme-production/traces/105445aa7843bc8bf206b12000100000",
    spanId: "000000000000004a",
    labels: { instanceId: "instance-1" },
  };
  const push = {
    message: {
      messageId: "pubsub-message-1",
      publishTime: "2026-07-13T10:15:31Z",
      data: Buffer.from(JSON.stringify(entry)).toString("base64"),
    },
    subscription: "projects/superlog-observability/subscriptions/superlog-connection",
  };

  const payload = gcpPubSubLogToOtlp(Buffer.from(JSON.stringify(push)), "acme-production");
  const rows = otlpLogsToRows(payload, "superlog-project-id");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.Body, "checkout failed");
  assert.equal(row.SeverityText, "ERROR");
  assert.equal(row.ServiceName, "checkout-api");
  assert.equal(row.TraceId, "105445aa7843bc8bf206b12000100000");
  assert.equal(row.SpanId, "000000000000004a");
  assert.equal(row.ResourceAttributes["cloud.provider"], "gcp");
  assert.equal(row.ResourceAttributes["gcp.project.id"], "acme-production");
  assert.equal(row.ResourceAttributes["gcp.resource.type"], "cloud_run_revision");
  assert.equal(row.LogAttributes["gcp.insert_id"], "abc-123");
  assert.equal(row.LogAttributes["gcp.pubsub.message_id"], "pubsub-message-1");

  assert.throws(
    () => gcpPubSubLogToOtlp(Buffer.from(JSON.stringify(push)), "another-project"),
    /does not belong to connected project/,
  );
});
