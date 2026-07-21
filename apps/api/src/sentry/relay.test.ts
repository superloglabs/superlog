import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { mountSentryMcpRelayPublic } from "./relay.js";

test("relays an authenticated project-scoped MCP request with Sentry-Bearer auth", async () => {
  const upstream: Array<{ url: string; init: RequestInit }> = [];
  const app = new Hono();
  mountSentryMcpRelayPublic(app, {
    repository: {
      getActive: async () => ({
        id: "sentry-install-1",
        sentryInstallationId: "sentry-external-installation-1",
        organizationSlug: "acme",
        projectSlug: "storefront",
        accessToken: "sentry-access-token",
        refreshToken: "sentry-refresh-token",
        relayToken: "relay-token",
        expiresAt: new Date("2026-07-22T12:00:00.000Z"),
      }),
      updateToken: async () => assert.fail("fresh credentials must not refresh"),
      markNeedsReauth: async () => assert.fail("fresh credentials must not need reauth"),
    },
    now: () => new Date("2026-07-21T12:00:00.000Z"),
    fetch: async (input, init) => {
      upstream.push({ url: String(input), init: init ?? {} });
      return new Response('{"jsonrpc":"2.0","result":{}}', {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
      });
    },
    clientId: "client-1",
    clientSecret: "secret-1",
  });

  const response = await app.request("/api/sentry-mcp-relay/project-1", {
    method: "POST",
    headers: {
      authorization: "Bearer relay-token",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: '{"jsonrpc":"2.0","method":"initialize","id":1}',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), "session-1");
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0]?.url, "https://mcp.sentry.dev/mcp/acme/storefront?skills=inspect");
  const headers = new Headers(upstream[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Sentry-Bearer sentry-access-token");
  assert.equal(headers.get("mcp-protocol-version"), "2025-06-18");
});

test("refreshes an expired Sentry token before relaying investigation queries", async () => {
  const updated: unknown[] = [];
  const current = {
    id: "sentry-install-1",
    sentryInstallationId: "sentry-external-installation-1",
    organizationSlug: "acme",
    projectSlug: "storefront",
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    relayToken: "relay-token",
    expiresAt: new Date("2026-07-21T12:00:30.000Z"),
  };
  const upstreamAuth: string[] = [];
  const app = new Hono();
  mountSentryMcpRelayPublic(app, {
    repository: {
      getActive: async () => current,
      updateToken: async (id, token) => {
        updated.push({ id, token });
        return { ...current, ...token };
      },
      markNeedsReauth: async () => assert.fail("successful refresh must not require reauth"),
    },
    now: () => new Date("2026-07-21T12:00:00.000Z"),
    fetch: async (input, init) => {
      if (
        String(input) ===
        "https://sentry.io/api/0/sentry-app-installations/sentry-external-installation-1/authorizations/"
      ) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          grant_type: "refresh_token",
          refresh_token: "refresh-token",
          client_id: "client-1",
          client_secret: "secret-1",
        });
        return Response.json({
          token: "fresh-access",
          refreshToken: "next-refresh-token",
          expiresAt: "2026-07-21T20:00:00.000Z",
        });
      }
      upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ jsonrpc: "2.0", result: {} });
    },
    clientId: "client-1",
    clientSecret: "secret-1",
  });

  const response = await app.request("/api/sentry-mcp-relay/project-1", {
    method: "POST",
    headers: { authorization: "Bearer relay-token" },
    body: "{}",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(updated, [
    {
      id: "sentry-install-1",
      token: {
        accessToken: "fresh-access",
        refreshToken: "next-refresh-token",
        expiresAt: new Date("2026-07-21T20:00:00.000Z"),
      },
    },
  ]);
  assert.deepEqual(upstreamAuth, ["Sentry-Bearer fresh-access"]);
});

test("marks the installation for reconnect when Sentry rejects its OAuth token", async () => {
  const reauth: Array<{ id: string; reason: string }> = [];
  const app = new Hono();
  mountSentryMcpRelayPublic(app, {
    repository: {
      getActive: async () => ({
        id: "sentry-install-1",
        sentryInstallationId: "sentry-external-installation-1",
        organizationSlug: "acme",
        projectSlug: "storefront",
        accessToken: "revoked-access-token",
        refreshToken: "refresh-token",
        relayToken: "relay-token",
        expiresAt: null,
      }),
      updateToken: async () => assert.fail("a non-expired token must not refresh eagerly"),
      markNeedsReauth: async (id, reason) => {
        reauth.push({ id, reason });
      },
    },
    now: () => new Date("2026-07-21T12:00:00.000Z"),
    fetch: async () => Response.json({ detail: "Invalid token" }, { status: 401 }),
    clientId: "client-1",
    clientSecret: "secret-1",
  });

  const response = await app.request("/api/sentry-mcp-relay/project-1", {
    method: "POST",
    headers: { authorization: "Bearer relay-token" },
    body: "{}",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(reauth, [
    { id: "sentry-install-1", reason: "Sentry MCP rejected OAuth token (401)" },
  ]);
});
