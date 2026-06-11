import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";

// Importing oauth.ts pulls in @superlog/db, whose client throws at import time
// when DATABASE_URL is unset. postgres-js connects lazily, so a dummy value is
// enough — the branches under test never touch the database.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";

async function mountRegister(): Promise<Hono> {
  const { mountOauthEndpoints } = await import("./oauth.js");
  const { loadMcpConfig } = await import("./config.js");
  const app = new Hono();
  mountOauthEndpoints(app, loadMcpConfig());
  return app;
}

async function isValid(uri: string): Promise<boolean> {
  const { isValidRedirectUri } = await import("./oauth.js");
  return isValidRedirectUri(uri);
}

test("accepts https redirect URIs", async () => {
  assert.equal(await isValid("https://example.com/oauth/callback"), true);
});

test("accepts http loopback redirect URIs", async () => {
  assert.equal(await isValid("http://localhost:33418/callback"), true);
  assert.equal(await isValid("http://127.0.0.1:33418/callback"), true);
});

test("rejects http redirect URIs on non-loopback hosts", async () => {
  assert.equal(await isValid("http://example.com/callback"), false);
});

test("accepts private-use scheme redirect URIs from native MCP clients", async () => {
  // RFC 8252 §7.1: native apps use private-use URI schemes for their OAuth
  // callbacks. These are real registration payloads seen from MCP clients.
  assert.equal(await isValid("cursor://anysphere.cursor-mcp/oauth/callback"), true);
  assert.equal(await isValid("vscode://ms-vscode.vscode-mcp/authorize"), true);
  assert.equal(await isValid("com.example.app:/oauth2redirect"), true);
});

test("rejects redirect URIs with browser-executable or local-resource schemes", async () => {
  for (const uri of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "blob:https://example.com/uuid",
    "about:blank",
    "vbscript:msgbox(1)",
  ]) {
    assert.equal(await isValid(uri), false, `expected ${uri} to be rejected`);
  }
});

test("rejects strings that are not URIs", async () => {
  assert.equal(await isValid("not a uri"), false);
  assert.equal(await isValid(""), false);
});

test("register endpoint accepts a native-app private-use scheme past redirect validation", async () => {
  const app = await mountRegister();
  // The dummy DATABASE_URL means the insert that follows validation cannot
  // succeed — but a 400 invalid_redirect_uri specifically means validation
  // rejected the URI before ever reaching the database. Assert on the body.
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Cursor",
      redirect_uris: ["javascript:alert(1)"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_redirect_uri");
});
