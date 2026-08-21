import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type GcpApplicationConfig,
  completeGcpConnect,
  disconnectGcpConnection,
  updateGcpLogExclusions,
} from "./application.js";
import type {
  GcpConnectionRecord,
  GcpConnectionRepository,
  GcpDeprovisioningInput,
  GcpGateway,
  GcpProvisioningInput,
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
  excludedLogNames: [],
  monitoringViewerGrantCreated: false,
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

test("a manager can exclude exact log names from a connected GCP project", async () => {
  let saved: string[] | null = null;
  const connected = { ...connection, status: "connected" as const };
  const repository = {
    async findCurrent() {
      return connected;
    },
    async updateExcludedLogNames(_id: string, excludedLogNames: string[]) {
      saved = excludedLogNames;
      return { ...connected, excludedLogNames };
    },
  } as unknown as GcpConnectionRepository;

  const updated = await updateGcpLogExclusions({
    projectId: connection.projectId,
    excludedLogNames: [
      " projects/acme-production/logs/run.googleapis.com%2Fstderr ",
      "projects/acme-production/logs/run.googleapis.com%2Fstderr",
      "projects/acme-production/logs/cloudaudit.googleapis.com%2Factivity",
    ],
    repository,
  });

  assert.deepEqual(saved, [
    "projects/acme-production/logs/cloudaudit.googleapis.com%2Factivity",
    "projects/acme-production/logs/run.googleapis.com%2Fstderr",
  ]);
  assert.deepEqual(updated.excludedLogNames, saved);
});

const provisioned: ProvisionedGcpConnection = {
  gcpProjectNumber: "123456789012",
  topicName: "superlog-connection-id",
  subscriptionName: "superlog-connection-id",
  logSinkName: "superlog-connection-id",
  logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
  monitoringViewerGrantCreated: true,
};

test("disconnecting a connected GCP project removes its cloud resources before revoking it", async () => {
  const events: string[] = [];
  const connected: GcpConnectionRecord = {
    ...connection,
    ...provisioned,
    status: "connected",
  };
  const repository = {
    async findCurrent(projectId: string) {
      assert.equal(projectId, connected.projectId);
      return connected;
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async claimDisconnect(id: string) {
      assert.equal(id, connected.id);
      events.push("claim-disconnect");
      return { ...connected, status: "disconnecting" as const };
    },
    async revoke(id: string) {
      assert.equal(id, connected.id);
      events.push("revoke-connection");
      return { ...connected, revokedAt: new Date("2026-08-21T12:00:00.000Z") };
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async deprovision(input: GcpDeprovisioningInput) {
      assert.deepEqual(input, {
        connectionId: connected.id,
        gcpProjectId: connected.gcpProjectId,
        userAccessToken: "temporary-user-token",
        integrationProjectId: config.integrationProjectId,
        readerServiceAccountEmail: connected.readerServiceAccountEmail,
        provisioned,
      });
      events.push("deprovision-connection");
    },
  } as unknown as GcpGateway;

  const result = await disconnectGcpConnection({
    projectId: connected.projectId,
    userAccessToken: "temporary-user-token",
    repository,
    gateway,
    config,
  });

  assert.ok(result.revokedAt);
  assert.deepEqual(events, ["claim-disconnect", "deprovision-connection", "revoke-connection"]);
});

test("a failed disconnect revocation restores the connected GCP resources", async () => {
  const events: string[] = [];
  const connected: GcpConnectionRecord = {
    ...connection,
    ...provisioned,
    status: "connected",
  };
  const repository = {
    async findCurrent() {
      return connected;
    },
    async findById() {
      return { ...connected, status: "disconnecting" as const };
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async claimDisconnect() {
      events.push("claim-disconnect");
      return { ...connected, status: "disconnecting" as const };
    },
    async revoke() {
      events.push("revoke-connection");
      throw new Error("database unavailable");
    },
    async releaseDisconnect() {
      events.push("release-disconnect");
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async deprovision() {
      events.push("deprovision-connection");
    },
    async provision(input: GcpProvisioningInput) {
      assert.equal(input.connectionId, connected.id);
      assert.equal(input.userAccessToken, "temporary-user-token");
      events.push("restore-connection");
      return provisioned;
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    disconnectGcpConnection({
      projectId: connected.projectId,
      userAccessToken: "temporary-user-token",
      repository,
      gateway,
      config,
    }),
    /database unavailable/,
  );

  assert.deepEqual(events, [
    "claim-disconnect",
    "deprovision-connection",
    "revoke-connection",
    "restore-connection",
    "release-disconnect",
  ]);
});

test("a partially failed cloud cleanup restores the connected GCP resources", async () => {
  const events: string[] = [];
  const connected: GcpConnectionRecord = {
    ...connection,
    ...provisioned,
    status: "connected",
  };
  const repository = {
    async findCurrent() {
      return connected;
    },
    async findById() {
      return { ...connected, status: "disconnecting" as const };
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async claimDisconnect() {
      events.push("claim-disconnect");
      return { ...connected, status: "disconnecting" as const };
    },
    async revoke() {
      events.push("revoke-connection");
      return { ...connected, revokedAt: new Date() };
    },
    async releaseDisconnect() {
      events.push("release-disconnect");
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async deprovision() {
      events.push("deprovision-connection");
      throw new Error("partial cleanup failure");
    },
    async provision(input: GcpProvisioningInput) {
      assert.equal(input.connectionId, connected.id);
      events.push("restore-connection");
      return provisioned;
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    disconnectGcpConnection({
      projectId: connected.projectId,
      userAccessToken: "temporary-user-token",
      repository,
      gateway,
      config,
    }),
    /partial cleanup failure/,
  );

  assert.deepEqual(events, [
    "claim-disconnect",
    "deprovision-connection",
    "restore-connection",
    "release-disconnect",
  ]);
});

test("an overlapping disconnect cannot clean up a connection claimed by another request", async () => {
  const events: string[] = [];
  const connected: GcpConnectionRecord = {
    ...connection,
    ...provisioned,
    status: "connected",
  };
  const repository = {
    async findCurrent() {
      return connected;
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async claimDisconnect() {
      events.push("claim-disconnect");
      throw new Error("GCP disconnect is already in progress");
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async deprovision() {
      events.push("deprovision-connection");
    },
    async provision() {
      events.push("restore-connection");
      return provisioned;
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    disconnectGcpConnection({
      projectId: connected.projectId,
      userAccessToken: "temporary-user-token",
      repository,
      gateway,
      config,
    }),
    /already in progress/,
  );

  assert.deepEqual(events, ["claim-disconnect"]);
});

test("a local persistence failure removes newly provisioned Google resources", async () => {
  const cleanupCalls: unknown[] = [];
  const repository = {
    async findById() {
      return connection;
    },
    async findCurrent() {
      return connection;
    },
    async prepareMonitoringGrantRemoval() {
      return true;
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

test("an OAuth callback cannot reclaim a connection while disconnect is in progress", async () => {
  let provisioningCalls = 0;
  const disconnecting = {
    ...connection,
    ...provisioned,
    status: "disconnecting" as const,
  };
  const repository = {
    async findById() {
      return disconnecting;
    },
    async findCurrent() {
      return disconnecting;
    },
    async markProvisioning() {
      provisioningCalls += 1;
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async provision() {
      provisioningCalls += 1;
      return provisioned;
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    completeGcpConnect({
      connectionId: disconnecting.id,
      userAccessToken: "temporary-user-token",
      repository,
      gateway,
      config,
    }),
    /disconnect is in progress/,
  );

  assert.equal(provisioningCalls, 0);
});

test("replacing a connected GCP project removes its cloud resources before superseding it", async () => {
  const events: string[] = [];
  const oldConnection: GcpConnectionRecord = {
    ...connection,
    id: "old-connection-id",
    gcpProjectId: "acme-staging",
    readerServiceAccountEmail: "legacy-reader@example.iam.gserviceaccount.com",
    gcpProjectNumber: "987654321098",
    status: "connected",
    topicName: "superlog-old-connection-id",
    subscriptionName: "superlog-old-connection-id",
    logSinkName: "superlog-old-connection-id",
    logSinkWriterIdentity: "serviceAccount:old-cloud-logs@system.gserviceaccount.com",
    monitoringViewerGrantCreated: true,
  };
  const connected = {
    ...connection,
    ...provisioned,
    status: "connected" as const,
  };
  const repository = {
    async findById() {
      return connection;
    },
    async findCurrent() {
      return oldConnection;
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async markProvisioning() {},
    async ensureIngestKey() {},
    async markConnected(
      _id: string,
      _result: ProvisionedGcpConnection,
      supersededConnectionId: string | null,
    ) {
      assert.equal(supersededConnectionId, oldConnection.id);
      events.push("supersede-old-connection");
      return connected;
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
    async deprovision(input: GcpDeprovisioningInput) {
      events.push(`deprovision-${input.connectionId}`);
      assert.equal(input.readerServiceAccountEmail, oldConnection.readerServiceAccountEmail);
      assert.deepEqual(input.provisioned, {
        gcpProjectNumber: "987654321098",
        topicName: "superlog-old-connection-id",
        subscriptionName: "superlog-old-connection-id",
        logSinkName: "superlog-old-connection-id",
        logSinkWriterIdentity: "serviceAccount:old-cloud-logs@system.gserviceaccount.com",
        monitoringViewerGrantCreated: true,
      });
    },
  } as unknown as GcpGateway;

  const result = await completeGcpConnect({
    connectionId: connection.id,
    code: "code",
    repository,
    gateway,
    config,
  });

  assert.equal(result, connected);
  assert.deepEqual(events, ["deprovision-old-connection-id", "supersede-old-connection"]);
});

test("replacement preserves a monitoring grant shared by another active connection", async () => {
  const oldConnection: GcpConnectionRecord = {
    ...connection,
    id: "old-connection-id",
    gcpProjectId: "shared-production",
    gcpProjectNumber: "987654321098",
    status: "connected",
    topicName: "superlog-old-connection-id",
    subscriptionName: "superlog-old-connection-id",
    logSinkName: "superlog-old-connection-id",
    logSinkWriterIdentity: "serviceAccount:old-cloud-logs@system.gserviceaccount.com",
    monitoringViewerGrantCreated: true,
  };
  const connected = { ...connection, ...provisioned, status: "connected" as const };
  const repository = {
    async findById() {
      return connection;
    },
    async findCurrent() {
      return oldConnection;
    },
    async prepareMonitoringGrantRemoval(input: {
      connectionId: string;
      gcpProjectId: string;
      grantCreated: boolean;
    }) {
      assert.deepEqual(input, {
        connectionId: oldConnection.id,
        gcpProjectId: oldConnection.gcpProjectId,
        readerServiceAccountEmail: oldConnection.readerServiceAccountEmail,
        grantCreated: true,
      });
      return false;
    },
    async markProvisioning() {},
    async ensureIngestKey() {},
    async markConnected() {
      return connected;
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
    async deprovision(input: GcpDeprovisioningInput) {
      if (input.connectionId === oldConnection.id) {
        assert.equal(input.provisioned.monitoringViewerGrantCreated, false);
      }
    },
  } as unknown as GcpGateway;

  await completeGcpConnect({
    connectionId: connection.id,
    code: "code",
    repository,
    gateway,
    config,
  });
});

test("a failed database supersession restores the previous GCP resources", async () => {
  const events: string[] = [];
  const oldConnection: GcpConnectionRecord = {
    ...connection,
    id: "old-connection-id",
    gcpProjectId: "acme-staging",
    gcpProjectNumber: "987654321098",
    status: "connected",
    topicName: "superlog-old-connection-id",
    subscriptionName: "superlog-old-connection-id",
    logSinkName: "superlog-old-connection-id",
    logSinkWriterIdentity: "serviceAccount:old-cloud-logs@system.gserviceaccount.com",
  };
  const repository = {
    async findById(id: string) {
      return id === oldConnection.id ? oldConnection : connection;
    },
    async findCurrent() {
      return oldConnection;
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async markProvisioning() {},
    async ensureIngestKey() {},
    async markConnected() {
      events.push("supersede-old-connection");
      throw new Error("database unavailable");
    },
    async markFailed() {},
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async exchangeCode() {
      return { accessToken: "temporary-user-token" };
    },
    async provision(input: { connectionId: string }) {
      events.push(`provision-${input.connectionId}`);
      return provisioned;
    },
    async deprovision(input: GcpDeprovisioningInput) {
      events.push(`deprovision-${input.connectionId}`);
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    completeGcpConnect({
      connectionId: connection.id,
      code: "code",
      repository,
      gateway,
      config,
    }),
    /database unavailable/,
  );

  assert.deepEqual(events, [
    "provision-connection-id",
    "deprovision-old-connection-id",
    "supersede-old-connection",
    "provision-old-connection-id",
    "deprovision-connection-id",
  ]);
});

test("an overlapping completion does not restore resources for a superseded connection", async () => {
  const events: string[] = [];
  const oldConnection: GcpConnectionRecord = {
    ...connection,
    id: "old-connection-id",
    gcpProjectId: "acme-staging",
    gcpProjectNumber: "987654321098",
    status: "connected",
    topicName: "superlog-old-connection-id",
    subscriptionName: "superlog-old-connection-id",
    logSinkName: "superlog-old-connection-id",
    logSinkWriterIdentity: "serviceAccount:old-cloud-logs@system.gserviceaccount.com",
  };
  const repository = {
    async findById(id: string) {
      if (id === oldConnection.id) return { ...oldConnection, revokedAt: new Date() };
      return connection;
    },
    async findCurrent() {
      return oldConnection;
    },
    async prepareMonitoringGrantRemoval() {
      return false;
    },
    async markProvisioning() {},
    async ensureIngestKey() {},
    async markConnected() {
      events.push("mark-connected");
      throw new Error("another GCP connection completed first");
    },
    async markFailed() {},
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async exchangeCode() {
      return { accessToken: "temporary-user-token" };
    },
    async provision(input: { connectionId: string }) {
      events.push(`provision-${input.connectionId}`);
      return provisioned;
    },
    async deprovision(input: GcpDeprovisioningInput) {
      events.push(`deprovision-${input.connectionId}`);
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    completeGcpConnect({
      connectionId: connection.id,
      code: "code",
      repository,
      gateway,
      config,
    }),
    /another GCP connection completed first/,
  );

  assert.deepEqual(events, [
    "provision-connection-id",
    "deprovision-old-connection-id",
    "mark-connected",
    "deprovision-connection-id",
  ]);
});
