import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";

test("OAuth discovery advertises read and write MCP scopes", async () => {
  const { mountOauthMetadata } = await import("./oauth.js");
  const { loadMcpConfig } = await import("./config.js");
  const app = new Hono();
  mountOauthMetadata(app, loadMcpConfig());

  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
  ]) {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as { scopes_supported?: string[] };
    assert.deepEqual(metadata.scopes_supported, ["mcp:read", "mcp:write"]);
  }
});
