import "dotenv/config";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { StsVerifier } from "./cloud-connections-service.js";
import { type CloudConnectConfig, mountCloudConnectionsAuthed } from "./cloud-connections.js";
import type { DiscoveredResource, ResourceLister } from "./cloud-resources-service.js";

// encrypt/decrypt of the external ID needs a key; any 32-byte key works for tests.
process.env.AGENT_SECRETS_KEY ||= randomBytes(32).toString("base64");

const CONFIG: CloudConnectConfig = {
  superlogAccountId: "123456789012",
  templateUrl: "https://cfn.example/aws-connect.yaml",
};

type ConnBody = {
  id: string;
  region: string;
  scrapeRoleArn: string | null;
  accountId: string | null;
  status: string;
  lastError: string | null;
  launchUrl?: string;
  externalId?: string;
  externalIdCiphertext?: unknown;
  externalIdNonce?: unknown;
};

const asConn = async (res: Response): Promise<ConnBody> => (await res.json()) as ConnBody;

const orgIds: string[] = [];

before(async () => {
  await runMigrations();
});

after(async () => {
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
  } finally {
    await closeDb();
  }
});

async function seedProject(role: "owner" | "admin" | "member" = "owner") {
  const tag = `cc-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "test", slug: tag })
    .returning();
  if (!project) throw new Error("seed project failed");
  return { org, user, project };
}

test("an ordinary member cannot connect an AWS account", async () => {
  const { org, user, project } = await seedProject("member");
  const app = appFor(user.id, org.id, okSts("210987654321"));

  const res = await app.request(`/api/projects/${project.id}/cloud-connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ region: "us-west-2" }),
  });

  assert.equal(res.status, 403);
  assert.equal(
    await db.query.cloudConnections.findFirst({
      where: eq(schema.cloudConnections.projectId, project.id),
    }),
    undefined,
  );
});

// Fully-configured one-step connect: combined template + both Firehose intakes.
const COMBINED_CONFIG: CloudConnectConfig = {
  superlogAccountId: "123456789012",
  templateUrl: "https://cfn.example/aws-connect.yaml",
  connectStackTemplateUrl: "https://cfn.example/connect-stack.yaml",
  metricsIntakeUrl: "https://intake.example.com/aws/firehose/metrics",
  logsIntakeUrl: "https://intake.example.com/aws/firehose/logs",
  callbackUrl: "https://api.example.com/api/cloud-connections/callback",
};

function appWith(
  userId: string,
  orgId: string,
  sts: StsVerifier,
  config: CloudConnectConfig,
  resourceLister?: ResourceLister,
) {
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("*", (c, next) => {
    c.set("userId", userId);
    c.set("orgId", orgId);
    return next();
  });
  // No-op config fetcher so tests never reach real AWS Cloud Control.
  mountCloudConnectionsAuthed(app, {
    sts,
    config,
    resourceLister,
    configFetcher: {
      async get() {
        return null;
      },
    },
  });
  return app;
}

function appFor(userId: string, orgId: string, sts: StsVerifier, resourceLister?: ResourceLister) {
  return appWith(userId, orgId, sts, CONFIG, resourceLister);
}

const fragOf = (url: string) =>
  new URLSearchParams(new URL(url).hash.slice(new URL(url).hash.indexOf("?") + 1));

const okSts = (accountId: string): StsVerifier => ({
  async verifyAssumeRole() {
    return { accountId };
  },
});

test("connect returns a launch url + persists a pending connection (no secret leak)", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id, okSts("210987654321"));

  const res = await app.request(`/api/projects/${project.id}/cloud-connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ region: "us-west-2" }),
  });
  assert.equal(res.status, 200);
  const body = await asConn(res);

  assert.equal(body.status, "pending");
  assert.equal(body.scrapeRoleArn, null);
  assert.ok(body.externalId, "externalId returned");
  assert.ok(body.launchUrl, "launchUrl returned");
  assert.match(body.externalId, /^[A-Za-z0-9_-]{40,}$/);
  assert.ok(body.launchUrl.includes("param_ExternalId="));
  assert.ok(body.launchUrl.includes("param_SuperlogAccountId=123456789012"));
  // encrypted columns must never be serialized
  assert.equal(body.externalIdCiphertext, undefined);
  assert.equal(body.externalIdNonce, undefined);

  const row = await db.query.cloudConnections.findFirst({
    where: eq(schema.cloudConnections.id, body.id),
  });
  assert.equal(row?.status, "pending");
  assert.equal(row?.scrapeRoleArn, null);
});

test("verify with a matching account marks the connection connected", async () => {
  const { org, user, project } = await seedProject();
  const roleArn = "arn:aws:iam::210987654321:role/SuperlogScrape";
  // assert the STS port receives the decrypted external id
  const sts: StsVerifier = {
    async verifyAssumeRole({ roleArn: r, externalId }) {
      assert.equal(r, roleArn);
      assert.match(externalId, /^[A-Za-z0-9_-]{40,}$/);
      return { accountId: "210987654321" };
    },
  };
  const app = appFor(user.id, org.id, sts);

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );

  const res = await app.request(
    `/api/projects/${project.id}/cloud-connections/${created.id}/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scrapeRoleArn: roleArn }),
    },
  );
  assert.equal(res.status, 200);
  const body = await asConn(res);
  assert.equal(body.status, "connected");
  assert.equal(body.accountId, "210987654321");
  assert.equal(body.scrapeRoleArn, roleArn);
});

test("metrics-stream mints an ingest key + returns a launch url for a connected conn", async () => {
  const { org, user, project } = await seedProject();
  const roleArn = "arn:aws:iam::210987654321:role/SuperlogScrape";
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("*", (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    return next();
  });
  mountCloudConnectionsAuthed(app, {
    sts: okSts("210987654321"),
    config: {
      ...CONFIG,
      metricsTemplateUrl: "https://cfn.example/metrics-stream.yaml",
      metricsIntakeUrl: "https://intake.example.com/aws/firehose/metrics",
    },
  });

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  await app.request(`/api/projects/${project.id}/cloud-connections/${created.id}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scrapeRoleArn: roleArn }),
  });

  const res = await app.request(
    `/api/projects/${project.id}/cloud-connections/${created.id}/metrics-stream`,
    { method: "POST" },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { launchUrl: string; keyPrefix: string };
  assert.ok(body.launchUrl.includes("param_IntakeUrl="));
  assert.ok(
    body.launchUrl.includes(encodeURIComponent("https://intake.example.com/aws/firehose/metrics")),
  );
  assert.ok(body.launchUrl.includes("param_IngestKey=sl_public_"));
  assert.match(body.keyPrefix, /^sl_public_/);

  // A real, project-scoped ingest key was persisted (so the stream authenticates).
  const keys = await db.query.apiKeys.findMany({
    where: eq(schema.apiKeys.projectId, project.id),
  });
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.name, "AWS metric stream (us-west-2)");
});

test("logs-stream mints a log-stream key + returns the logs stack launch url", async () => {
  const { org, user, project } = await seedProject();
  const roleArn = "arn:aws:iam::210987654321:role/SuperlogScrape";
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("*", (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    return next();
  });
  mountCloudConnectionsAuthed(app, {
    sts: okSts("210987654321"),
    config: {
      ...CONFIG,
      logsTemplateUrl: "https://cfn.example/logs-stream.yaml",
      logsIntakeUrl: "https://intake.example.com/aws/firehose/logs",
    },
  });

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  await app.request(`/api/projects/${project.id}/cloud-connections/${created.id}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scrapeRoleArn: roleArn }),
  });

  const res = await app.request(
    `/api/projects/${project.id}/cloud-connections/${created.id}/logs-stream`,
    { method: "POST" },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { launchUrl: string; keyPrefix: string };
  assert.ok(
    body.launchUrl.includes(encodeURIComponent("https://intake.example.com/aws/firehose/logs")),
  );
  assert.match(body.keyPrefix, /^sl_public_/);

  const keys = await db.query.apiKeys.findMany({
    where: eq(schema.apiKeys.projectId, project.id),
  });
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.name, "AWS log stream (us-west-2)");
});

type Health = {
  components: { key: string; state: string; detail: string; lastReceivedAt: string | null }[];
};
const comp = (h: Health, key: string) => h.components.find((c) => c.key === key);

test("stack-health reflects setup, and metric-stream setup is idempotent", async () => {
  const { org, user, project } = await seedProject();
  const roleArn = "arn:aws:iam::210987654321:role/SuperlogScrape";
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("*", (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    return next();
  });
  mountCloudConnectionsAuthed(app, {
    sts: okSts("210987654321"),
    config: {
      ...CONFIG,
      metricsTemplateUrl: "https://cfn.example/metrics-stream.yaml",
      metricsIntakeUrl: "https://intake.example.com/aws/firehose/metrics",
    },
  });

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  await app.request(`/api/projects/${project.id}/cloud-connections/${created.id}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scrapeRoleArn: roleArn }),
  });

  // Before setup: connection working, both streams missing.
  const before = (await (
    await app.request(`/api/projects/${project.id}/cloud-connections/${created.id}/stack-health`)
  ).json()) as Health;
  assert.equal(comp(before, "connection")?.state, "working");
  assert.equal(comp(before, "metrics")?.state, "missing");
  assert.equal(comp(before, "logs")?.state, "missing");

  // Set up metric streaming → pending (set up, no data yet).
  const first = (await (
    await app.request(
      `/api/projects/${project.id}/cloud-connections/${created.id}/metrics-stream`,
      {
        method: "POST",
      },
    )
  ).json()) as { launchUrl: string; keyPrefix: string };

  const after = (await (
    await app.request(`/api/projects/${project.id}/cloud-connections/${created.id}/stack-health`)
  ).json()) as Health;
  assert.equal(comp(after, "metrics")?.state, "pending");
  assert.equal(comp(after, "logs")?.state, "missing");

  // Idempotent re-launch: same key reused (no sprawl), identical launch URL.
  const second = (await (
    await app.request(
      `/api/projects/${project.id}/cloud-connections/${created.id}/metrics-stream`,
      {
        method: "POST",
      },
    )
  ).json()) as { launchUrl: string; keyPrefix: string };
  assert.equal(second.keyPrefix, first.keyPrefix);
  assert.equal(second.launchUrl, first.launchUrl);
  const metricKeys = await db.query.apiKeys.findMany({
    where: and(
      eq(schema.apiKeys.projectId, project.id),
      eq(schema.apiKeys.name, "AWS metric stream (us-west-2)"),
    ),
  });
  assert.equal(metricKeys.length, 1, "re-launch must not mint a second key");
});

test("metrics-stream is 409 until the connection is verified", async () => {
  const { org, user, project } = await seedProject();
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("*", (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    return next();
  });
  mountCloudConnectionsAuthed(app, {
    sts: okSts("210987654321"),
    config: {
      ...CONFIG,
      metricsTemplateUrl: "https://cfn.example/metrics-stream.yaml",
      metricsIntakeUrl: "https://intake.example.com/aws/firehose/metrics",
    },
  });

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  const res = await app.request(
    `/api/projects/${project.id}/cloud-connections/${created.id}/metrics-stream`,
    { method: "POST" },
  );
  assert.equal(res.status, 409);
  // No key minted on the failure path.
  const keys = await db.query.apiKeys.findMany({
    where: eq(schema.apiKeys.projectId, project.id),
  });
  assert.equal(keys.length, 0);
});

test("metrics-stream is 501 when metric streaming isn't configured", async () => {
  const { org, user, project } = await seedProject();
  // Base CONFIG has no metricsTemplateUrl/metricsIntakeUrl.
  const app = appFor(user.id, org.id, okSts("210987654321"));
  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  const res = await app.request(
    `/api/projects/${project.id}/cloud-connections/${created.id}/metrics-stream`,
    { method: "POST" },
  );
  assert.equal(res.status, 501);
});

test("one-step connect launches the combined stack + mints both stream keys", async () => {
  const { org, user, project } = await seedProject();
  const app = appWith(user.id, org.id, okSts("210987654321"), COMBINED_CONFIG);

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );

  assert.ok(created.launchUrl, "expected a launch url");
  const frag = fragOf(created.launchUrl);
  // One combined stack, streaming on by default, with both intakes + the callback URL.
  assert.equal(frag.get("templateURL"), "https://cfn.example/connect-stack.yaml");
  assert.equal(frag.get("stackName"), "superlog-connect");
  assert.equal(frag.get("param_EnableMetrics"), "true");
  assert.equal(frag.get("param_EnableLogs"), "true");
  assert.equal(
    frag.get("param_MetricsIntakeUrl"),
    "https://intake.example.com/aws/firehose/metrics",
  );
  assert.equal(frag.get("param_LogsIntakeUrl"), "https://intake.example.com/aws/firehose/logs");
  assert.equal(
    frag.get("param_SuperlogCallbackUrl"),
    "https://api.example.com/api/cloud-connections/callback",
  );
  // Dedicated per-signal keys, distinct, both embedded in the launch URL.
  const mKey = frag.get("param_MetricsIngestKey");
  const lKey = frag.get("param_LogsIngestKey");
  assert.ok(mKey && lKey && mKey !== lKey, "expected two distinct ingest keys");

  // Both stream keys persisted up front (so reconciliation tracks each signal).
  const sk = await db.query.cloudStreamKeys.findMany({
    where: eq(schema.cloudStreamKeys.connectionId, created.id),
  });
  assert.equal(sk.length, 2);
  assert.deepEqual(sk.map((r) => r.kind).sort(), ["logs", "metrics"]);
});

test("one-step re-launch (metrics-stream) reuses the same combined stack + keys", async () => {
  const { org, user, project } = await seedProject();
  const app = appWith(user.id, org.id, okSts("210987654321"), COMBINED_CONFIG);

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  assert.ok(created.launchUrl, "expected a launch url");
  const keyAtConnect = fragOf(created.launchUrl).get("param_MetricsIngestKey");
  // Verify, then "Re-launch metric streaming" → must return the SAME combined
  // stack with the SAME key (no new key, no parallel stack).
  await app.request(`/api/projects/${project.id}/cloud-connections/${created.id}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scrapeRoleArn: "arn:aws:iam::210987654321:role/SuperlogScrapeRole" }),
  });
  const relaunch = (await (
    await app.request(
      `/api/projects/${project.id}/cloud-connections/${created.id}/metrics-stream`,
      { method: "POST" },
    )
  ).json()) as { launchUrl: string; keyPrefix: string };
  const frag = fragOf(relaunch.launchUrl);
  assert.equal(frag.get("stackName"), "superlog-connect");
  assert.equal(frag.get("param_MetricsIngestKey"), keyAtConnect);

  // Still exactly two stream keys — re-launch minted nothing new.
  const sk = await db.query.cloudStreamKeys.findMany({
    where: eq(schema.cloudStreamKeys.connectionId, created.id),
  });
  assert.equal(sk.length, 2);
});

test("re-launch re-mints a stream key whose api key was revoked", async () => {
  const { org, user, project } = await seedProject();
  const app = appWith(user.id, org.id, okSts("210987654321"), COMBINED_CONFIG);

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  await app.request(`/api/projects/${project.id}/cloud-connections/${created.id}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scrapeRoleArn: "arn:aws:iam::210987654321:role/SuperlogScrapeRole" }),
  });

  // Revoke the metrics signal's api key out from under the stored stream key.
  const before = await db.query.cloudStreamKeys.findFirst({
    where: and(
      eq(schema.cloudStreamKeys.connectionId, created.id),
      eq(schema.cloudStreamKeys.kind, "metrics"),
    ),
  });
  assert.ok(before);
  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, before.apiKeyId));

  // Re-launch must NOT hand back the dead key — it re-mints in place.
  const relaunch = (await (
    await app.request(
      `/api/projects/${project.id}/cloud-connections/${created.id}/metrics-stream`,
      { method: "POST" },
    )
  ).json()) as { launchUrl: string };

  const after = await db.query.cloudStreamKeys.findFirst({
    where: and(
      eq(schema.cloudStreamKeys.connectionId, created.id),
      eq(schema.cloudStreamKeys.kind, "metrics"),
    ),
  });
  assert.ok(after);
  assert.notEqual(after.apiKeyId, before.apiKeyId);
  const newKey = await db.query.apiKeys.findFirst({
    where: eq(schema.apiKeys.id, after.apiKeyId),
  });
  assert.equal(newKey?.revokedAt, null);
  // Still one metrics row (re-minted in place, not duplicated).
  const all = await db.query.cloudStreamKeys.findMany({
    where: and(
      eq(schema.cloudStreamKeys.connectionId, created.id),
      eq(schema.cloudStreamKeys.kind, "metrics"),
    ),
  });
  assert.equal(all.length, 1);
  // Launch URL carries the live key (and not the revoked prefix).
  assert.ok(fragOf(relaunch.launchUrl).get("param_MetricsIngestKey"));
});

test("reconnecting a role already active in the project revokes the old row (no 500)", async () => {
  const { org, user, project } = await seedProject();
  const roleArn = "arn:aws:iam::210987654321:role/SuperlogScrapeRole";
  const app = appFor(user.id, org.id, okSts("210987654321"));

  const connectAndVerify = async () => {
    const created = await asConn(
      await app.request(`/api/projects/${project.id}/cloud-connections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ region: "us-west-2" }),
      }),
    );
    const res = await app.request(
      `/api/projects/${project.id}/cloud-connections/${created.id}/verify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scrapeRoleArn: roleArn }),
      },
    );
    return { id: created.id, res };
  };

  const first = await connectAndVerify();
  assert.equal(first.res.status, 200);

  // Second connect + verify of the SAME role used to 500 on the unique index.
  const second = await connectAndVerify();
  assert.equal(second.res.status, 200);
  assert.equal((await asConn(second.res)).status, "connected");

  // Exactly one active connection remains (the newest); the old one is revoked.
  const active = await db.query.cloudConnections.findMany({
    where: and(
      eq(schema.cloudConnections.projectId, project.id),
      isNull(schema.cloudConnections.revokedAt),
    ),
  });
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, second.id);
});

test("verify surfaces a denied assume-role as failed (200, not 500)", async () => {
  const { org, user, project } = await seedProject();
  const sts: StsVerifier = {
    async verifyAssumeRole() {
      throw new Error("AccessDenied: not authorized to perform sts:AssumeRole");
    },
  };
  const app = appFor(user.id, org.id, sts);

  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-east-1" }),
    }),
  );

  const res = await app.request(
    `/api/projects/${project.id}/cloud-connections/${created.id}/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scrapeRoleArn: "arn:aws:iam::210987654321:role/SuperlogScrape",
      }),
    },
  );
  assert.equal(res.status, 200);
  const body = await asConn(res);
  assert.equal(body.status, "failed");
  assert.ok(typeof body.lastError === "string" && body.lastError.length > 0);
});

test("a user cannot create a connection on another org's project", async () => {
  const a = await seedProject();
  const b = await seedProject();
  // user A acts, but targets project B
  const app = appFor(a.user.id, a.org.id, okSts("1"));
  const res = await app.request(`/api/projects/${b.project.id}/cloud-connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ region: "us-east-1" }),
  });
  assert.equal(res.status, 403);
});

// --- zero-paste callback (CloudFormation custom resource → in-stack Lambda) ----

test("callback with the right connectionId + externalId connects (no session)", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id, okSts("210987654321"));
  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );

  // The callback carries no session cookie — auth is connectionId + externalId.
  const res = await app.request("/api/cloud-connections/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      connectionId: created.id,
      externalId: created.externalId,
      roleArn: "arn:aws:iam::210987654321:role/SuperlogScrapeRole",
      accountId: "210987654321",
    }),
  });
  assert.equal(res.status, 200);
  const body = await asConn(res);
  assert.equal(body.status, "connected");
  assert.equal(body.accountId, "210987654321");
});

test("callback with a wrong externalId is rejected and does not connect", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id, okSts("210987654321"));
  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );

  const res = await app.request("/api/cloud-connections/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      connectionId: created.id,
      externalId: "not-the-real-external-id",
      roleArn: "arn:aws:iam::999999999999:role/Evil",
    }),
  });
  assert.equal(res.status, 403);

  const row = await db.query.cloudConnections.findFirst({
    where: eq(schema.cloudConnections.id, created.id),
  });
  assert.equal(row?.status, "pending"); // untouched
});

test("callback for an unknown connection is 404", async () => {
  const { org, user } = await seedProject();
  const app = appFor(user.id, org.id, okSts("1"));
  const res = await app.request("/api/cloud-connections/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      connectionId: "00000000-0000-0000-0000-000000000000",
      externalId: "whatever",
      roleArn: "arn:aws:iam::1:role/x",
    }),
  });
  assert.equal(res.status, 404);
});

// --- inventory sync + list ----------------------------------------------------

test("sync a connected connection populates the resource list", async () => {
  const { org, user, project } = await seedProject();
  const roleArn = "arn:aws:iam::210987654321:role/SuperlogScrapeRole";
  const lister: ResourceLister = {
    async list({ roleArn: r, externalId, region }) {
      assert.equal(r, roleArn);
      assert.match(externalId, /^[A-Za-z0-9_-]{40,}$/); // decrypted from the row
      assert.equal(region, "us-west-2");
      const out: DiscoveredResource[] = [
        { arn: "arn:aws:ec2:us-west-2:210987654321:instance/i-1", tags: { Name: "web" } },
        { arn: "arn:aws:rds:us-west-2:210987654321:db:prod", tags: {} },
      ];
      return out;
    },
  };
  const app = appFor(user.id, org.id, okSts("210987654321"), lister);

  // create → verify → connected
  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  await app.request(`/api/projects/${project.id}/cloud-connections/${created.id}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scrapeRoleArn: roleArn }),
  });

  const syncRes = await app.request(
    `/api/projects/${project.id}/cloud-connections/${created.id}/sync`,
    { method: "POST", headers: { "content-type": "application/json" } },
  );
  assert.equal(syncRes.status, 200);
  const syncBody = (await syncRes.json()) as { discovered: number; removed: number };
  assert.equal(syncBody.discovered, 2);
  assert.equal(syncBody.removed, 0);

  const list = (await (
    await app.request(`/api/projects/${project.id}/cloud-resources`)
  ).json()) as Array<{ service: string; name: string | null }>;
  assert.equal(list.length, 2);
  assert.ok(list.some((r) => r.service === "ec2" && r.name === "web"));
  assert.ok(list.some((r) => r.service === "rds"));
});

test("sync on an unverified connection is rejected (409)", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id, okSts("1"));
  const created = await asConn(
    await app.request(`/api/projects/${project.id}/cloud-connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-west-2" }),
    }),
  );
  const res = await app.request(
    `/api/projects/${project.id}/cloud-connections/${created.id}/sync`,
    { method: "POST", headers: { "content-type": "application/json" } },
  );
  assert.equal(res.status, 409);
});
