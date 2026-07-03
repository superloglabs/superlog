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
  });
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
    },
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
    }).vercelConnect,
    true,
  );
});
