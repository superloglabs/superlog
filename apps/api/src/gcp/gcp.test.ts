import "dotenv/config";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { GcpGateway } from "./domain.js";
import { mountGcpAuthed, mountGcpPublic, type GcpConnectConfig } from "./interfaces.js";

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
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "test", slug: tag })
    .returning();
  if (!project) throw new Error("seed project failed");
  return { org, user, project };
}

test("a project owner connects GCP without retaining their OAuth token", async () => {
  const { org, user, project } = await seedProject();
  const calls: Array<{ connectionId: string; accessToken: string; gcpProjectId: string }> = [];
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
    async provision(input) {
      calls.push({
        connectionId: input.connectionId,
        accessToken: input.userAccessToken,
        gcpProjectId: input.gcpProjectId,
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
      };
    },
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gcpProjectId: "acme-production" }),
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
  assert.equal(
    callback.headers.get("location"),
    "https://app.example.com/connect/gcp?gcp=connected",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.gcpProjectId, "acme-production");

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
