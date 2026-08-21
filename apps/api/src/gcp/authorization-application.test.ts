import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GcpApplicationConfig } from "./application.js";
import { disconnectGcpAuthorization, startGcpAuthorization } from "./authorization-application.js";
import {
  GCP_AUTHORIZATION_TTL_MS,
  type GcpAuthorizationRepository,
  type GcpAuthorizationSessionRecord,
  type GcpConnectionRecord,
  type GcpConnectionRepository,
  type GcpGateway,
} from "./domain.js";

test("a pending Google authorization and its signed state share one lifetime", async () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  let createCalled = false;
  const repository = {
    async create(input: { projectId: string; userId: string; expiresAt: Date }) {
      createCalled = true;
      assert.equal(input.expiresAt.getTime(), now.getTime() + GCP_AUTHORIZATION_TTL_MS);
      return {
        id: "authorization-id",
        ...input,
        status: "pending",
        projects: [],
        consumedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      } satisfies GcpAuthorizationSessionRecord;
    },
  } as unknown as GcpAuthorizationRepository;
  const gateway = {
    authorizationUrl: ({ state }: { state: string }) => `https://example.com/oauth?state=${state}`,
  } as GcpGateway;

  await startGcpAuthorization({
    projectId: "project-id",
    userId: "user-id",
    repository,
    gateway,
    signState: () => "signed-state",
    now,
  });

  assert.equal(createCalled, true);
});

test("a ready Google authorization disconnects the project's current GCP connection", async () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  const session: GcpAuthorizationSessionRecord = {
    id: "authorization-id",
    projectId: "project-id",
    userId: "user-id",
    status: "ready",
    projects: [
      {
        projectId: "acme-production",
        projectNumber: "123456789012",
        displayName: "Acme production",
      },
    ],
    expiresAt: new Date("2026-08-21T12:10:00.000Z"),
    consumedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  const connection: GcpConnectionRecord = {
    id: "connection-id",
    projectId: session.projectId,
    gcpProjectId: "acme-production",
    gcpProjectNumber: "123456789012",
    status: "connected",
    topicName: "superlog-connection-id",
    subscriptionName: "superlog-connection-id",
    logSinkName: "superlog-connection-id",
    logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
    excludedLogNames: [],
    monitoringViewerGrantCreated: true,
    readerServiceAccountEmail: "reader@example.iam.gserviceaccount.com",
    lastVerifiedAt: now,
    lastLogReceivedAt: null,
    lastMetricsReceivedAt: null,
    metricsBudgetMonth: null,
    metricsSeriesRead: 0,
    lastError: null,
    createdBy: session.userId,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const authorizationRepository = {
    async findById() {
      return session;
    },
    async claim(input: { gcpProjectId: string }) {
      assert.equal(input.gcpProjectId, connection.gcpProjectId);
      return {
        session: { ...session, status: "consumed" as const, consumedAt: now },
        project: session.projects[0],
        accessToken: "temporary-user-token",
      };
    },
  } as unknown as GcpAuthorizationRepository;
  const connectionRepository = {
    async findById() {
      return connection;
    },
    async claimDisconnect() {
      return { ...connection, status: "disconnecting" as const };
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async revoke() {
      return { ...connection, revokedAt: now };
    },
  } as unknown as GcpConnectionRepository;
  let deprovisioned = false;
  const gateway = {
    async deprovision() {
      deprovisioned = true;
    },
  } as unknown as GcpGateway;
  const config: GcpApplicationConfig = {
    integrationProjectId: "superlog-observability",
    readerServiceAccountEmail: connection.readerServiceAccountEmail,
    pushServiceAccountEmail: "push@example.iam.gserviceaccount.com",
    pushAudience: "https://intake.example.com/gcp/pubsub",
    pushEndpoint: "https://intake.example.com/gcp/pubsub",
  };

  const result = await disconnectGcpAuthorization({
    authorizationId: session.id,
    userId: session.userId,
    expectedConnectionId: connection.id,
    authorizationRepository,
    connectionRepository,
    gateway,
    config,
    now,
  });

  assert.ok(result.revokedAt);
  assert.equal(deprovisioned, true);
});

test("a disconnect authorization cannot target a replacement connection", async () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  const session: GcpAuthorizationSessionRecord = {
    id: "authorization-id",
    projectId: "project-id",
    userId: "user-id",
    status: "ready",
    projects: [
      {
        projectId: "acme-production",
        projectNumber: "123456789012",
        displayName: "Acme production",
      },
    ],
    expiresAt: new Date("2026-08-21T12:10:00.000Z"),
    consumedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  const original = {
    id: "original-connection-id",
    projectId: session.projectId,
    gcpProjectId: "acme-production",
    gcpProjectNumber: "123456789012",
    status: "connected" as const,
    topicName: "superlog-original-connection-id",
    subscriptionName: "superlog-original-connection-id",
    logSinkName: "superlog-original-connection-id",
    logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
    excludedLogNames: [],
    monitoringViewerGrantCreated: true,
    readerServiceAccountEmail: "reader@example.iam.gserviceaccount.com",
    lastVerifiedAt: now,
    lastLogReceivedAt: null,
    lastMetricsReceivedAt: null,
    metricsBudgetMonth: null,
    metricsSeriesRead: 0,
    lastError: null,
    createdBy: session.userId,
    revokedAt: now,
    createdAt: now,
    updatedAt: now,
  } satisfies GcpConnectionRecord;
  let claimCalls = 0;
  let deprovisionCalls = 0;
  const authorizationRepository = {
    async findById() {
      return session;
    },
    async claim() {
      claimCalls += 1;
      throw new Error("stale authorization must not be claimed");
    },
  } as unknown as GcpAuthorizationRepository;
  const connectionRepository = {
    async findById(id: string) {
      assert.equal(id, original.id);
      return original;
    },
    async findCurrent() {
      throw new Error("the current replacement connection must not be selected");
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async deprovision() {
      deprovisionCalls += 1;
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    disconnectGcpAuthorization({
      authorizationId: session.id,
      userId: session.userId,
      expectedConnectionId: original.id,
      authorizationRepository,
      connectionRepository,
      gateway,
      config: {
        integrationProjectId: "superlog-observability",
        readerServiceAccountEmail: original.readerServiceAccountEmail,
        pushServiceAccountEmail: "push@example.iam.gserviceaccount.com",
        pushAudience: "https://intake.example.com/gcp/pubsub",
        pushEndpoint: "https://intake.example.com/gcp/pubsub",
      },
      now,
    }),
    /Connected GCP project not found/,
  );

  assert.equal(claimCalls, 0);
  assert.equal(deprovisionCalls, 0);
});

test("a failed disconnect restores its Google authorization for retry", async () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  const retryExpiresAt = new Date("2026-08-21T12:03:00.000Z");
  const session: GcpAuthorizationSessionRecord = {
    id: "authorization-id",
    projectId: "project-id",
    userId: "user-id",
    status: "ready",
    projects: [
      {
        projectId: "acme-production",
        projectNumber: "123456789012",
        displayName: "Acme production",
      },
    ],
    expiresAt: new Date("2026-08-21T12:10:00.000Z"),
    consumedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  const connection = {
    id: "connection-id",
    projectId: session.projectId,
    gcpProjectId: "acme-production",
    gcpProjectNumber: "123456789012",
    status: "connected" as const,
    topicName: "superlog-connection-id",
    subscriptionName: "superlog-connection-id",
    logSinkName: "superlog-connection-id",
    logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
    excludedLogNames: [],
    monitoringViewerGrantCreated: true,
    readerServiceAccountEmail: "reader@example.iam.gserviceaccount.com",
    lastVerifiedAt: now,
    lastLogReceivedAt: null,
    lastMetricsReceivedAt: null,
    metricsBudgetMonth: null,
    metricsSeriesRead: 0,
    lastError: null,
    createdBy: session.userId,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  } satisfies GcpConnectionRecord;
  const events: string[] = [];
  const authorizationRepository = {
    async findById() {
      return session;
    },
    async claim() {
      events.push("claim-authorization");
      return {
        session: { ...session, status: "consumed" as const, consumedAt: now },
        project: session.projects[0],
        accessToken: "temporary-user-token",
      };
    },
    async restoreClaim(input: { accessToken: string; expiresAt: Date }) {
      assert.equal(input.accessToken, "temporary-user-token");
      assert.equal(input.expiresAt.getTime(), retryExpiresAt.getTime());
      events.push("restore-authorization");
    },
  } as unknown as GcpAuthorizationRepository;
  let connectionStatus: GcpConnectionRecord["status"] = "connected";
  const connectionRepository = {
    async findById() {
      return { ...connection, status: connectionStatus };
    },
    async claimDisconnect() {
      events.push("claim-disconnect");
      connectionStatus = "disconnecting";
      return { ...connection, status: connectionStatus };
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async releaseDisconnect() {
      events.push("release-disconnect");
      connectionStatus = "connected";
      return true;
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async deprovision() {
      events.push("deprovision");
      throw new Error("transient Google error");
    },
    async provision() {
      events.push("restore-resources");
      return {
        gcpProjectNumber: connection.gcpProjectNumber,
        topicName: connection.topicName,
        subscriptionName: connection.subscriptionName,
        logSinkName: connection.logSinkName,
        logSinkWriterIdentity: connection.logSinkWriterIdentity,
        monitoringViewerGrantCreated: connection.monitoringViewerGrantCreated,
      };
    },
  } as unknown as GcpGateway;

  await assert.rejects(
    disconnectGcpAuthorization({
      authorizationId: session.id,
      userId: session.userId,
      expectedConnectionId: connection.id,
      retryExpiresAt,
      authorizationRepository,
      connectionRepository,
      gateway,
      config: {
        integrationProjectId: "superlog-observability",
        readerServiceAccountEmail: connection.readerServiceAccountEmail,
        pushServiceAccountEmail: "push@example.iam.gserviceaccount.com",
        pushAudience: "https://intake.example.com/gcp/pubsub",
        pushEndpoint: "https://intake.example.com/gcp/pubsub",
      },
      now,
    }),
    /transient Google error/,
  );

  assert.deepEqual(events, [
    "claim-authorization",
    "claim-disconnect",
    "deprovision",
    "restore-resources",
    "release-disconnect",
    "restore-authorization",
  ]);
});

test("a disconnect whose revoke committed is returned as terminal success", async () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  const session: GcpAuthorizationSessionRecord = {
    id: "authorization-id",
    projectId: "project-id",
    userId: "user-id",
    status: "ready",
    projects: [
      {
        projectId: "acme-production",
        projectNumber: "123456789012",
        displayName: "Acme production",
      },
    ],
    expiresAt: new Date("2026-08-21T12:10:00.000Z"),
    consumedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  const connection = {
    id: "connection-id",
    projectId: session.projectId,
    gcpProjectId: "acme-production",
    gcpProjectNumber: "123456789012",
    status: "connected" as const,
    topicName: "superlog-connection-id",
    subscriptionName: "superlog-connection-id",
    logSinkName: "superlog-connection-id",
    logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
    excludedLogNames: [],
    monitoringViewerGrantCreated: true,
    readerServiceAccountEmail: "reader@example.iam.gserviceaccount.com",
    lastVerifiedAt: now,
    lastLogReceivedAt: null,
    lastMetricsReceivedAt: null,
    metricsBudgetMonth: null,
    metricsSeriesRead: 0,
    lastError: null,
    createdBy: session.userId,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  } satisfies GcpConnectionRecord;
  let latest = connection as GcpConnectionRecord;
  let restoreClaimCalls = 0;
  const authorizationRepository = {
    async findById() {
      return session;
    },
    async claim() {
      return {
        session: { ...session, status: "consumed" as const, consumedAt: now },
        project: session.projects[0],
        accessToken: "temporary-user-token",
      };
    },
    async restoreClaim() {
      restoreClaimCalls += 1;
    },
  } as unknown as GcpAuthorizationRepository;
  const connectionRepository = {
    async findById() {
      return latest;
    },
    async claimDisconnect() {
      latest = { ...connection, status: "disconnecting" };
      return latest;
    },
    async prepareMonitoringGrantRemoval() {
      return true;
    },
    async revoke() {
      latest = { ...latest, revokedAt: now };
      throw new Error("database response lost after commit");
    },
  } as unknown as GcpConnectionRepository;
  const gateway = {
    async deprovision() {},
  } as unknown as GcpGateway;

  const result = await disconnectGcpAuthorization({
    authorizationId: session.id,
    userId: session.userId,
    expectedConnectionId: connection.id,
    authorizationRepository,
    connectionRepository,
    gateway,
    config: {
      integrationProjectId: "superlog-observability",
      readerServiceAccountEmail: connection.readerServiceAccountEmail,
      pushServiceAccountEmail: "push@example.iam.gserviceaccount.com",
      pushAudience: "https://intake.example.com/gcp/pubsub",
      pushEndpoint: "https://intake.example.com/gcp/pubsub",
    },
    now,
  });

  assert.ok(result.revokedAt);
  assert.equal(restoreClaimCalls, 0);
});
