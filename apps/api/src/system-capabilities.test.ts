import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSystemCapabilities } from "./system-capabilities.js";

test("system capabilities default to the open-core community edition", () => {
  assert.deepEqual(buildSystemCapabilities({}), {
    edition: "community",
    billing: "none",
    managedAgents: false,
    ossAgents: true,
    cloudUpgradeLinks: true,
    cloudflareConnect: false,
    vercelConnect: false,
    railwayConnect: false,
    renderConnect: false,
    gcpConnect: false,
    sentryConnect: false,
  });
});

test("renderConnect only needs AGENT_SECRETS_KEY (API-key connect, no OAuth client)", () => {
  assert.equal(buildSystemCapabilities({}).renderConnect, false);
  assert.equal(buildSystemCapabilities({ AGENT_SECRETS_KEY: "k" }).renderConnect, true);
});

test("gcpConnect requires OAuth and integration-owned Pub/Sub configuration", () => {
  assert.equal(
    buildSystemCapabilities({ GCP_OAUTH_CLIENT_ID: "id", GCP_OAUTH_CLIENT_SECRET: "secret" })
      .gcpConnect,
    false,
  );
  const complete = {
    GCP_OAUTH_CLIENT_ID: "id",
    GCP_OAUTH_CLIENT_SECRET: "secret",
    GCP_OAUTH_REDIRECT_URI: "https://api.example.com/gcp/oauth/callback",
    GCP_INTEGRATION_PROJECT_ID: "superlog-observability",
    GCP_READER_SERVICE_ACCOUNT_EMAIL: "reader@example.iam.gserviceaccount.com",
    GCP_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: "push@example.iam.gserviceaccount.com",
    GCP_PUBSUB_PUSH_ENDPOINT: "https://intake.example.com/gcp/pubsub",
    GCP_PUBSUB_PUSH_AUDIENCE: "https://intake.example.com/gcp/pubsub",
    STATE_SIGNING_SECRET: "state-secret",
    AGENT_SECRETS_KEY: "encryption-key",
  };
  assert.equal(buildSystemCapabilities(complete).gcpConnect, true);
  assert.equal(
    buildSystemCapabilities({ ...complete, AGENT_SECRETS_KEY: undefined }).gcpConnect,
    false,
  );
  assert.equal(
    buildSystemCapabilities({ ...complete, GCP_PUBSUB_PUSH_AUDIENCE: undefined }).gcpConnect,
    true,
  );
});

test("railwayConnect flips on only when client creds + both platform secrets are set", () => {
  assert.equal(
    buildSystemCapabilities({ RAILWAY_CLIENT_ID: "id", RAILWAY_CLIENT_SECRET: "secret" })
      .railwayConnect,
    false,
  );
  // Provisioning encrypts secrets at rest, so AGENT_SECRETS_KEY is part of the
  // gate — without it the connect flow throws after consent.
  assert.equal(
    buildSystemCapabilities({
      RAILWAY_CLIENT_ID: "id",
      RAILWAY_CLIENT_SECRET: "secret",
      STATE_SIGNING_SECRET: "s",
    }).railwayConnect,
    false,
  );
  assert.equal(
    buildSystemCapabilities({
      RAILWAY_CLIENT_ID: "id",
      RAILWAY_CLIENT_SECRET: "secret",
      STATE_SIGNING_SECRET: "s",
      AGENT_SECRETS_KEY: "k",
    }).railwayConnect,
    true,
  );
});

test("cloudflareConnect flips on only when all connector vars (incl. STATE_SIGNING_SECRET) are set", () => {
  assert.equal(
    buildSystemCapabilities({ CLOUDFLARE_CLIENT_ID: "id", CLOUDFLARE_CLIENT_SECRET: "secret" })
      .cloudflareConnect,
    false,
  );
  // Connector creds present but no STATE_SIGNING_SECRET → install-url would 503,
  // so we must not advertise it as available.
  assert.equal(
    buildSystemCapabilities({
      CLOUDFLARE_CLIENT_ID: "id",
      CLOUDFLARE_CLIENT_SECRET: "secret",
      CLOUDFLARE_OTLP_INTAKE_URL: "https://intake.example.com",
    }).cloudflareConnect,
    false,
  );
  assert.equal(
    buildSystemCapabilities({
      CLOUDFLARE_CLIENT_ID: "id",
      CLOUDFLARE_CLIENT_SECRET: "secret",
      CLOUDFLARE_OTLP_INTAKE_URL: "https://intake.example.com",
      STATE_SIGNING_SECRET: "state-secret",
      AGENT_SECRETS_KEY: "k",
    }).cloudflareConnect,
    true,
  );
});

test("system capabilities expose cloud billing and managed agents when explicitly enabled", () => {
  assert.deepEqual(
    buildSystemCapabilities({
      SUPERLOG_EDITION: "cloud",
      SUPERLOG_BILLING_PROVIDER: "stripe",
      SUPERLOG_MANAGED_AGENTS_ENABLED: "true",
    }),
    {
      edition: "cloud",
      billing: "stripe",
      managedAgents: true,
      ossAgents: true,
      cloudUpgradeLinks: false,
      cloudflareConnect: false,
      vercelConnect: false,
      railwayConnect: false,
      renderConnect: false,
      gcpConnect: false,
      sentryConnect: false,
    },
  );
});

test("sentryConnect requires the public Sentry App and platform secrets", () => {
  assert.equal(
    buildSystemCapabilities({
      SENTRY_CLIENT_ID: "id",
      SENTRY_CLIENT_SECRET: "secret",
      SENTRY_APP_SLUG: "superlog",
    }).sentryConnect,
    false,
  );
  assert.equal(
    buildSystemCapabilities({
      SENTRY_CLIENT_ID: "id",
      SENTRY_CLIENT_SECRET: "secret",
      SENTRY_APP_SLUG: "superlog",
      STATE_SIGNING_SECRET: "state-secret",
      AGENT_SECRETS_KEY: "encryption-key",
    }).sentryConnect,
    true,
  );
});

test("vercelConnect flips on only when all connector vars (incl. STATE_SIGNING_SECRET) are set", () => {
  assert.equal(
    buildSystemCapabilities({ VERCEL_CLIENT_ID: "id", VERCEL_CLIENT_SECRET: "secret" })
      .vercelConnect,
    false,
  );
  // Connector creds present but no slug → install-url can't be formed.
  assert.equal(
    buildSystemCapabilities({
      VERCEL_CLIENT_ID: "id",
      VERCEL_CLIENT_SECRET: "secret",
      VERCEL_OTLP_INTAKE_URL: "https://intake.example.com",
      STATE_SIGNING_SECRET: "state-secret",
    }).vercelConnect,
    false,
  );
  assert.equal(
    buildSystemCapabilities({
      VERCEL_CLIENT_ID: "id",
      VERCEL_CLIENT_SECRET: "secret",
      VERCEL_INTEGRATION_SLUG: "superlog",
      VERCEL_OTLP_INTAKE_URL: "https://intake.example.com",
      STATE_SIGNING_SECRET: "state-secret",
      AGENT_SECRETS_KEY: "k",
    }).vercelConnect,
    true,
  );
});
