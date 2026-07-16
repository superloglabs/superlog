import "dotenv/config";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { projectHasIngested } from "../demo.js";
import type { GcpGateway } from "./domain.js";
import {
  type GcpConnectConfig,
  gcpConfigFromEnv,
  mountGcpAuthed,
  mountGcpPublic,
} from "./interfaces.js";
import { DrizzleGcpConnectionRepository } from "./repository.js";

process.env.STATE_SIGNING_SECRET ||= "gcp-test-state-secret";
process.env.AGENT_SECRETS_KEY ||= randomBytes(32).toString("base64");

const config: GcpConnectConfig = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://api.example.com/gcp/oauth/callback",
  webOrigin: "https://app.example.com",
  integrationProjectId: "superlog-observability",
  readerServiceAccountEmail: "reader@superlog-observability.iam.gserviceaccount.com",
  pushServiceAccountEmail: "push@superlog-observability.iam.gserviceaccount.com",
  pushAudience: "https://intake.example.com/gcp/pubsub",
  pushEndpoint: "https://intake.example.com/gcp/pubsub",
};

const orgIds: string[] = [];
const userIds: string[] = [];

test("GCP config requires the secrets key before starting OAuth", () => {
  const env = {
    GCP_OAUTH_CLIENT_ID: "google-client-id",
    GCP_OAUTH_CLIENT_SECRET: "google-client-secret",
    GCP_OAUTH_REDIRECT_URI: "https://api.example.com/gcp/oauth/callback",
    GCP_INTEGRATION_PROJECT_ID: "superlog-observability",
    GCP_READER_SERVICE_ACCOUNT_EMAIL: "reader@example.iam.gserviceaccount.com",
    GCP_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: "push@example.iam.gserviceaccount.com",
    GCP_PUBSUB_PUSH_ENDPOINT: "https://intake.example.com/gcp/pubsub",
  } as NodeJS.ProcessEnv;

  assert.equal(gcpConfigFromEnv(env), null);
  assert.ok(gcpConfigFromEnv({ ...env, AGENT_SECRETS_KEY: "encryption-key" }));
});

before(async () => {
  await runMigrations();
});

after(async () => {
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
    for (const userId of userIds.reverse()) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  } finally {
    await closeDb();
  }
});

async function seedProject() {
  const tag = `gcp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  userIds.push(user.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "test", slug: tag })
    .returning();
  if (!project) throw new Error("seed project failed");
  return { org, user, project };
}

test("a project owner discovers Google projects before choosing one to connect", async () => {
  const { org, user, project } = await seedProject();
  const calls: Array<{
    connectionId: string;
    accessToken: string;
    gcpProjectId: string;
    gcpProjectNumber: string | undefined;
  }> = [];
  const gateway: GcpGateway = {
    authorizationUrl({ state }) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "https://www.googleapis.com/auth/cloud-platform");
      return url.toString();
    },
    async exchangeCode(code) {
      assert.equal(code, "oauth-code");
      return { accessToken: "temporary-user-token" };
    },
    async listProjects(accessToken) {
      assert.equal(accessToken, "temporary-user-token");
      return [
        {
          projectId: "acme-production",
          projectNumber: "123456789012",
          displayName: "Acme production",
        },
        {
          projectId: "acme-staging",
          projectNumber: "210987654321",
          displayName: "Acme staging",
        },
      ];
    },
    async provision(input) {
      calls.push({
        connectionId: input.connectionId,
        accessToken: input.userAccessToken,
        gcpProjectId: input.gcpProjectId,
        gcpProjectNumber: input.gcpProjectNumber,
      });
      assert.equal(input.integrationProjectId, "superlog-observability");
      assert.equal(
        input.readerServiceAccountEmail,
        "reader@superlog-observability.iam.gserviceaccount.com",
      );
      assert.match(input.pushEndpoint, new RegExp(`${input.connectionId}$`));
      return {
        gcpProjectNumber: "123456789012",
        logSinkName: `superlog-${input.connectionId}`,
        logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
        topicName: `superlog-${input.connectionId}`,
        subscriptionName: `superlog-${input.connectionId}`,
        monitoringViewerGrantCreated: true,
      };
    },
    async deprovision() {},
  };

  const app = new Hono<{
    Variables: { userId: string; orgId: string | null };
  }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    await next();
  });
  mountGcpPublic(app, { config, gateway });
  mountGcpAuthed(app, { config, gateway });

  const start = await app.request(`/api/projects/${project.id}/gcp/install-url`, {
    method: "POST",
  });
  assert.equal(start.status, 200);
  const { url } = (await start.json()) as { url: string };
  const authorizationUrl = new URL(url);
  assert.equal(
    authorizationUrl.searchParams.get("scope"),
    "https://www.googleapis.com/auth/cloud-platform",
  );

  const callback = await app.request(
    `/gcp/oauth/callback?code=oauth-code&state=${encodeURIComponent(
      authorizationUrl.searchParams.get("state") ?? "",
    )}`,
  );
  assert.equal(callback.status, 302);
  const selectionUrl = new URL(callback.headers.get("location") ?? "");
  assert.equal(selectionUrl.origin + selectionUrl.pathname, "https://app.example.com/connect/gcp");
  assert.equal(selectionUrl.searchParams.get("gcp"), "select");
  const authorizationId = selectionUrl.searchParams.get("authorization");
  assert.ok(authorizationId);
  assert.equal(calls.length, 0);

  const projects = await app.request(`/api/gcp/authorizations/${authorizationId}`);
  assert.equal(projects.status, 200);
  const readyAuthorization = await db.query.gcpAuthorizationSessions.findFirst({
    where: eq(schema.gcpAuthorizationSessions.id, authorizationId),
  });
  assert.equal(readyAuthorization?.status, "ready");
  assert.ok(readyAuthorization?.accessTokenCiphertext);
  assert.notEqual(
    readyAuthorization.accessTokenCiphertext.toString("utf8"),
    "temporary-user-token",
  );
  assert.ok(
    readyAuthorization.expiresAt.getTime() <= Date.now() + 10 * 60 * 1000,
    "the usable grant must expire within ten minutes",
  );
  assert.deepEqual(await projects.json(), {
    id: authorizationId,
    expiresAt: readyAuthorization.expiresAt.toISOString(),
    projects: [
      {
        projectId: "acme-production",
        projectNumber: "123456789012",
        displayName: "Acme production",
      },
      {
        projectId: "acme-staging",
        projectNumber: "210987654321",
        displayName: "Acme staging",
      },
    ],
  });

  const [otherManager] = await db
    .insert(schema.users)
    .values({ email: `other-${Date.now()}@example.com` })
    .returning();
  assert.ok(otherManager);
  userIds.push(otherManager.id);
  await db
    .insert(schema.orgMembers)
    .values({ orgId: org.id, userId: otherManager.id, role: "owner" });
  const otherApp = new Hono<{
    Variables: { userId: string; orgId: string | null };
  }>();
  otherApp.use("/api/*", async (c, next) => {
    c.set("userId", otherManager.id);
    c.set("orgId", org.id);
    await next();
  });
  mountGcpAuthed(otherApp, { config, gateway });
  const otherManagerRead = await otherApp.request(`/api/gcp/authorizations/${authorizationId}`);
  assert.equal(otherManagerRead.status, 404);

  const invalidSelection = await app.request(`/api/gcp/authorizations/${authorizationId}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gcpProjectId: "not-returned-by-google" }),
  });
  assert.equal(invalidSelection.status, 400);
  assert.equal(calls.length, 0);

  const connect = await app.request(`/api/gcp/authorizations/${authorizationId}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gcpProjectId: "acme-production" }),
  });
  assert.equal(connect.status, 200);
  assert.deepEqual(await connect.json(), { connected: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.gcpProjectId, "acme-production");
  assert.equal(calls[0]?.gcpProjectNumber, "123456789012");

  const consumedAuthorization = await db.query.gcpAuthorizationSessions.findFirst({
    where: eq(schema.gcpAuthorizationSessions.id, authorizationId),
  });
  assert.equal(consumedAuthorization?.status, "consumed");
  assert.ok(consumedAuthorization?.consumedAt);
  assert.equal(consumedAuthorization?.accessTokenCiphertext, null);
  assert.equal(consumedAuthorization?.accessTokenNonce, null);
  assert.equal(consumedAuthorization?.accessTokenKeyVersion, null);

  const replay = await app.request(`/api/gcp/authorizations/${authorizationId}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gcpProjectId: "acme-production" }),
  });
  assert.equal(replay.status, 409);
  assert.equal(calls.length, 1);

  const status = await app.request(`/api/projects/${project.id}/gcp/connection`);
  assert.equal(status.status, 200);
  const connected = (await status.json()) as Record<string, unknown>;
  assert.equal(connected.connected, true);
  assert.equal(connected.gcpProjectId, "acme-production");
  assert.equal(connected.gcpProjectNumber, "123456789012");
  assert.equal(connected.status, "connected");
  assert.equal(connected.accessToken, undefined);
  assert.equal(connected.refreshToken, undefined);
});

test("denying Google consent marks the pending connection failed", async () => {
  const { org, user, project } = await seedProject();
  const gateway: GcpGateway = {
    authorizationUrl({ state }) {
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`;
    },
    async exchangeCode() {
      throw new Error("denied callbacks must not exchange a code");
    },
    async listProjects() {
      throw new Error("denied callbacks must not list projects");
    },
    async provision() {
      throw new Error("denied callbacks must not provision resources");
    },
    async deprovision() {},
  };
  const app = new Hono<{
    Variables: { userId: string; orgId: string | null };
  }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    await next();
  });
  mountGcpPublic(app, { config, gateway });
  mountGcpAuthed(app, { config, gateway });

  const start = await app.request(`/api/projects/${project.id}/gcp/install-url`, {
    method: "POST",
  });
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);

  const callback = await app.request(
    `/gcp/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "https://app.example.com/connect/gcp?gcp=denied");

  const authorization = await db.query.gcpAuthorizationSessions.findFirst({
    where: eq(schema.gcpAuthorizationSessions.projectId, project.id),
  });
  assert.equal(authorization?.status, "failed");
  assert.equal(authorization?.lastError, "Google OAuth access denied");
});

test("completing an older OAuth tab does not revoke a newer pending connection", async () => {
  const { user, project } = await seedProject();
  const [older] = await db
    .insert(schema.gcpConnections)
    .values({
      projectId: project.id,
      gcpProjectId: "acme-production",
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      createdBy: user.id,
    })
    .returning();
  const [newer] = await db
    .insert(schema.gcpConnections)
    .values({
      projectId: project.id,
      gcpProjectId: "acme-staging",
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      createdBy: user.id,
    })
    .returning();
  assert.ok(older && newer);

  const repository = new DrizzleGcpConnectionRepository();
  await repository.markConnected(
    older.id,
    {
      gcpProjectNumber: "123456789012",
      topicName: `superlog-${older.id}`,
      subscriptionName: `superlog-${older.id}`,
      logSinkName: `superlog-${older.id}`,
      logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
      monitoringViewerGrantCreated: false,
    },
    null,
  );

  const stillPending = await db.query.gcpConnections.findFirst({
    where: eq(schema.gcpConnections.id, newer.id),
  });
  assert.equal(stillPending?.status, "pending");
  assert.equal(stillPending?.revokedAt, null);
});

test("superseding a GCP connection revokes its ingest key", async () => {
  const { user, project } = await seedProject();
  const [ingestKey] = await db
    .insert(schema.apiKeys)
    .values({
      projectId: project.id,
      name: "GCP metrics puller",
      keyPrefix: "sl_public_old",
      keyHash: `gcp-superseded-${crypto.randomUUID()}`,
    })
    .returning();
  assert.ok(ingestKey);
  const [old, candidate] = await db
    .insert(schema.gcpConnections)
    .values([
      {
        projectId: project.id,
        gcpProjectId: "acme-old",
        readerServiceAccountEmail: config.readerServiceAccountEmail,
        createdBy: user.id,
        status: "connected",
        apiKeyId: ingestKey.id,
      },
      {
        projectId: project.id,
        gcpProjectId: "acme-new",
        readerServiceAccountEmail: config.readerServiceAccountEmail,
        createdBy: user.id,
      },
    ])
    .returning();
  assert.ok(old && candidate);

  await new DrizzleGcpConnectionRepository().markConnected(
    candidate.id,
    {
      gcpProjectNumber: "123456789012",
      topicName: `superlog-${candidate.id}`,
      subscriptionName: `superlog-${candidate.id}`,
      logSinkName: `superlog-${candidate.id}`,
      logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
      monitoringViewerGrantCreated: true,
    },
    old.id,
  );

  const revokedKey = await db.query.apiKeys.findFirst({
    where: eq(schema.apiKeys.id, ingestKey.id),
  });
  assert.ok(revokedKey?.revokedAt);
});

test("connecting after an overlapping callback cannot create a second active connection", async () => {
  const { user, project } = await seedProject();
  const inserted = await db
    .insert(schema.gcpConnections)
    .values([
      {
        projectId: project.id,
        gcpProjectId: "acme-old",
        readerServiceAccountEmail: config.readerServiceAccountEmail,
        createdBy: user.id,
        status: "connected",
      },
      {
        projectId: project.id,
        gcpProjectId: "acme-overlap",
        readerServiceAccountEmail: config.readerServiceAccountEmail,
        createdBy: user.id,
        status: "connected",
      },
      {
        projectId: project.id,
        gcpProjectId: "acme-new",
        readerServiceAccountEmail: config.readerServiceAccountEmail,
        createdBy: user.id,
      },
    ])
    .returning();
  const old = inserted[0];
  const overlapping = inserted[1];
  const candidate = inserted[2];
  assert.ok(old && overlapping && candidate);

  await assert.rejects(
    new DrizzleGcpConnectionRepository().markConnected(
      candidate.id,
      {
        gcpProjectNumber: "123456789012",
        topicName: `superlog-${candidate.id}`,
        subscriptionName: `superlog-${candidate.id}`,
        logSinkName: `superlog-${candidate.id}`,
        logSinkWriterIdentity: "serviceAccount:cloud-logs@system.gserviceaccount.com",
        monitoringViewerGrantCreated: true,
      },
      old.id,
    ),
    /another GCP connection completed first/,
  );

  const rows = await db.query.gcpConnections.findMany({
    where: eq(schema.gcpConnections.projectId, project.id),
  });
  assert.equal(rows.find((row) => row.id === old.id)?.revokedAt, null);
  assert.equal(rows.find((row) => row.id === overlapping.id)?.revokedAt, null);
  assert.equal(rows.find((row) => row.id === candidate.id)?.status, "pending");
});

test("preserving a shared monitoring grant transfers cleanup ownership", async () => {
  const first = await seedProject();
  const second = await seedProject();
  const [owner] = await db
    .insert(schema.gcpConnections)
    .values({
      projectId: first.project.id,
      gcpProjectId: "shared-production",
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      createdBy: first.user.id,
      status: "connected",
      monitoringViewerGrantCreated: true,
    })
    .returning();
  const [remaining] = await db
    .insert(schema.gcpConnections)
    .values({
      projectId: second.project.id,
      gcpProjectId: "shared-production",
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      createdBy: second.user.id,
      status: "connected",
      monitoringViewerGrantCreated: false,
    })
    .returning();
  assert.ok(owner && remaining);

  const shouldRemove = await new DrizzleGcpConnectionRepository().prepareMonitoringGrantRemoval({
    connectionId: owner.id,
    gcpProjectId: owner.gcpProjectId,
    readerServiceAccountEmail: owner.readerServiceAccountEmail,
    grantCreated: true,
  });

  assert.equal(shouldRemove, false);
  const transferred = await db.query.gcpConnections.findFirst({
    where: eq(schema.gcpConnections.id, remaining.id),
  });
  assert.equal(transferred?.monitoringViewerGrantCreated, true);
});

test("a monitoring grant is not transferred to a different reader principal", async () => {
  const first = await seedProject();
  const second = await seedProject();
  const [owner] = await db
    .insert(schema.gcpConnections)
    .values({
      projectId: first.project.id,
      gcpProjectId: "rotated-reader-production",
      readerServiceAccountEmail: "old-reader@example.iam.gserviceaccount.com",
      createdBy: first.user.id,
      status: "connected",
      monitoringViewerGrantCreated: true,
    })
    .returning();
  const [remaining] = await db
    .insert(schema.gcpConnections)
    .values({
      projectId: second.project.id,
      gcpProjectId: "rotated-reader-production",
      readerServiceAccountEmail: "new-reader@example.iam.gserviceaccount.com",
      createdBy: second.user.id,
      status: "connected",
      monitoringViewerGrantCreated: false,
    })
    .returning();
  assert.ok(owner && remaining);

  const shouldRemove = await new DrizzleGcpConnectionRepository().prepareMonitoringGrantRemoval({
    connectionId: owner.id,
    gcpProjectId: owner.gcpProjectId,
    readerServiceAccountEmail: owner.readerServiceAccountEmail,
    grantCreated: true,
  });

  assert.equal(shouldRemove, true);
  const unrelated = await db.query.gcpConnections.findFirst({
    where: eq(schema.gcpConnections.id, remaining.id),
  });
  assert.equal(unrelated?.monitoringViewerGrantCreated, false);
});

test("a failed reconnect does not hide an older working GCP connection", async () => {
  const { user, project } = await seedProject();
  const [connected] = await db
    .insert(schema.gcpConnections)
    .values({
      projectId: project.id,
      gcpProjectId: "acme-production",
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      createdBy: user.id,
      status: "connected",
      createdAt: new Date("2026-07-13T00:00:00Z"),
    })
    .returning();
  await db.insert(schema.gcpConnections).values({
    projectId: project.id,
    gcpProjectId: "acme-staging",
    readerServiceAccountEmail: config.readerServiceAccountEmail,
    createdBy: user.id,
    status: "failed",
    lastError: "OAuth denied",
    createdAt: new Date("2026-07-14T00:00:00Z"),
  });
  assert.ok(connected);

  const current = await new DrizzleGcpConnectionRepository().findCurrent(project.id);

  assert.equal(current?.id, connected.id);
  assert.equal(current?.status, "connected");
});

test("a stale callback failure cannot demote an already connected row", async () => {
  const { user, project } = await seedProject();
  const [connection] = await db
    .insert(schema.gcpConnections)
    .values({
      projectId: project.id,
      gcpProjectId: "acme-production",
      readerServiceAccountEmail: config.readerServiceAccountEmail,
      createdBy: user.id,
      status: "connected",
    })
    .returning();
  assert.ok(connection);
  const repository = new DrizzleGcpConnectionRepository();

  await repository.markProvisioning(connection.id);
  await repository.markFailed(connection.id, "late OAuth callback failed");

  const current = await repository.findById(connection.id);
  assert.equal(current?.status, "connected");
  assert.equal(current?.lastError, null);
});

test("starting the same GCP project twice reuses one active connection", async () => {
  const { user, project } = await seedProject();
  const repository = new DrizzleGcpConnectionRepository();
  const input = {
    projectId: project.id,
    gcpProjectId: "acme-production",
    readerServiceAccountEmail: config.readerServiceAccountEmail,
    createdBy: user.id,
  };

  const first = await repository.create(input);
  const second = await repository.create(input);

  assert.equal(second.id, first.id);
  const active = await db.query.gcpConnections.findMany({
    where: eq(schema.gcpConnections.projectId, project.id),
  });
  assert.equal(active.filter((item) => item.revokedAt === null).length, 1);
});

test("accepted GCP logs mark a project as ingested without an API key request", async () => {
  const { project } = await seedProject();
  await db
    .update(schema.projects)
    .set({ firstTelemetryAt: new Date() })
    .where(eq(schema.projects.id, project.id));

  assert.equal(await projectHasIngested(project.id), true);
});

test("starting Google OAuth does not require a project id request body", async () => {
  const { org, user, project } = await seedProject();
  const gateway = {
    authorizationUrl() {
      return "https://accounts.google.com/o/oauth2/v2/auth";
    },
    async exchangeCode() {
      return { accessToken: "unused" };
    },
    async listProjects() {
      return [];
    },
    async provision() {
      throw new Error("unused");
    },
    async deprovision() {},
  } satisfies GcpGateway;
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    await next();
  });
  mountGcpAuthed(app, { config, gateway });

  const response = await app.request(`/api/projects/${project.id}/gcp/install-url`, {
    method: "POST",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: "https://accounts.google.com/o/oauth2/v2/auth",
  });
});
