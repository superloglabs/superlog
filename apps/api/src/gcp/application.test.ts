import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type GcpApplicationConfig, completeGcpConnect } from "./application.js";
import type {
  GcpConnectionRecord,
  GcpConnectionRepository,
  GcpGateway,
  ProvisionedGcpConnection,
} from "./domain.js";

const config: GcpApplicationConfig = {
  integrationProjectId: "superlog-observability",
  readerServiceAccountEmail: "reader@superlog-observability.iam.gserviceaccount.com",
  pushServiceAccountEmail: "push@superlog-observability.iam.gserviceaccount.com",
  pushAudience: "https://intake.example.com/gcp/pubsub",
  pushEndpoint: "https://intake.example.com/gcp/pubsub",
};

const connection: GcpConnectionRecord = {
  id: "connection-id",
  projectId: "project-id",
  gcpProjectId: "acme-production",
  gcpProjectNumber: null,
  status: "pending",
  topicName: null,
  subscriptionName: null,
  logSinkName: null,
  logSinkWriterIdentity: null,
  readerServiceAccountEmail: config.readerServiceAccountEmail,
  lastVerifiedAt: null,
  lastLogReceivedAt: null,
  lastMetricsReceivedAt: null,
  metricsBudgetMonth: null,
  metricsSeriesRead: 0,
  lastError: null,
  createdBy: "user-id",
  revokedAt: null,
  createdAt: new Date("2026-07-14T00:00:00Z"),
  updatedAt: new Date("2026-07-14T00:00:00Z"),
};

const provisioned: ProvisionedGcpConnection = {
  gcpProjectNumber: "123456789012",
  topicName: "superlog-connection-id",
  subscriptionName: "superlog-connection-id",
  logSinkName: "superlog-connection-id",
  logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
  monitoringViewerGrantCreated: true,
};

test("a local persistence failure removes newly provisioned Google resources", async () => {
  const cleanupCalls: unknown[] = [];
  const repository = {
    async findById() {
      return connection;
    },
    async markProvisioning() {},
    async ensureIngestKey() {
      throw new Error("database unavailable");
    },
    async markFailed() {},
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async exchangeCode() {
      return { accessToken: "temporary-user-token" };
    },
    async provision() {
      return provisioned;
    },
    async deprovision(input: unknown) {
      cleanupCalls.push(input);
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    completeGcpConnect({ connectionId: connection.id, code: "code", repository, gateway, config }),
    /database unavailable/,
  );
  assert.deepEqual(cleanupCalls, [
    {
      connectionId: connection.id,
      gcpProjectId: connection.gcpProjectId,
      userAccessToken: "temporary-user-token",
      integrationProjectId: config.integrationProjectId,
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      provisioned,
    },
  ]);
});

test("replaying a completed OAuth callback leaves the connected connection unchanged", async () => {
  let provisioningCalls = 0;
  let exchangeCalls = 0;
  const connected = { ...connection, status: "connected" as const };
  const repository = {
    async findById() {
      return connected;
    },
    async markProvisioning() {
      provisioningCalls += 1;
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async exchangeCode() {
      exchangeCalls += 1;
      throw new Error("one-time code was already consumed");
    },
  } as unknown as GcpGateway;

  const result = await completeGcpConnect({
    connectionId: connection.id,
    code: "replayed-code",
    repository,
    gateway,
    config,
  });

  assert.equal(result, connected);
  assert.equal(provisioningCalls, 0);
  assert.equal(exchangeCalls, 0);
});
