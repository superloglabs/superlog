import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  claimsKnownClientName,
  describeClientForConsent,
  describeRedirectUri,
  shouldRedirectOnDeny,
} from "./oauth-client-trust.js";

test("loopback redirects are trusted and shown as this computer", () => {
  for (const uri of [
    "http://localhost:33418/callback",
    "http://127.0.0.1:1455/auth/callback",
    "http://[::1]:8080/callback",
  ]) {
    const d = describeRedirectUri(uri);
    assert.equal(d?.kind, "loopback", uri);
    assert.equal(d?.trusted, true, uri);
  }
});

test("known MCP client callbacks are trusted", () => {
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://vscode.dev/redirect",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "vscode://ms-vscode.vscode-mcp/authorize",
  ]) {
    assert.equal(describeRedirectUri(uri)?.trusted, true, uri);
  }
});

test("unknown web hosts and lookalike hosts are not trusted", () => {
  for (const uri of [
    "https://widgets.example/cb",
    "https://claude.ai.widgets.example/cb",
    "https://widgets-claude.ai/cb",
    "http://claude.ai/api/mcp/auth_callback",
  ]) {
    const d = describeRedirectUri(uri);
    assert.equal(d?.kind, "web", uri);
    assert.equal(d?.trusted, false, uri);
  }
  assert.equal(
    describeRedirectUri("https://widgets.example:8443/cb")?.target,
    "widgets.example:8443",
  );
});

test("unknown app schemes are shown but not trusted", () => {
  const d = describeRedirectUri("com.acme.widgets:/oauth2redirect");
  assert.deepEqual(d, { kind: "app", target: "com.acme.widgets", trusted: false });
});

test("known client names are detected through spacing and case", () => {
  assert.equal(claimsKnownClientName("Claude Code"), true);
  assert.equal(claimsKnownClientName("claude-code (superlog)"), true);
  assert.equal(claimsKnownClientName("Visual Studio Code"), true);
  assert.equal(claimsKnownClientName("C u r s o r"), true);
  assert.equal(claimsKnownClientName("Acme Widgets"), false);
});

test("a known name on an unknown web redirect is marked unverified", () => {
  const d = describeClientForConsent(
    { name: "Claude Code", redirectUris: ["https://widgets.example/cb"] },
    "https://widgets.example/cb",
  );
  assert.equal(d.verified, false);
  assert.equal(d.name, "Unverified: Claude Code");
  assert.deepEqual(d.redirect, { kind: "web", target: "widgets.example", trusted: false });
});

test("one unknown redirect among trusted ones makes the client unverified", () => {
  const d = describeClientForConsent(
    { name: "Cursor", redirectUris: ["http://127.0.0.1:1/cb", "https://widgets.example/cb"] },
    "http://127.0.0.1:1/cb",
  );
  assert.equal(d.verified, false);
  assert.equal(d.name, "Unverified: Cursor");
});

test("real MCP client registrations keep their names", () => {
  const cases = [
    { name: "Claude Code (superlog)", redirectUris: ["http://localhost:51234/callback"] },
    { name: "Codex", redirectUris: ["http://127.0.0.1:1455/auth/callback"] },
    { name: "Cursor", redirectUris: ["cursor://anysphere.cursor-mcp/oauth/callback"] },
    {
      name: "Visual Studio Code",
      redirectUris: ["http://127.0.0.1:33418", "https://vscode.dev/redirect"],
    },
    { name: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] },
  ];
  for (const client of cases) {
    const d = describeClientForConsent(client, client.redirectUris[0] ?? null);
    assert.equal(d.verified, true, client.name);
    assert.equal(d.name, client.name);
  }
});

test("an unverified client with an ordinary name is not renamed", () => {
  const d = describeClientForConsent(
    { name: "Acme Widgets", redirectUris: ["https://widgets.example/cb"] },
    null,
  );
  assert.equal(d.verified, false);
  assert.equal(d.name, "Acme Widgets");
  assert.equal(d.redirect, null);
});

test("deny only redirects to trusted redirect URIs", () => {
  assert.equal(shouldRedirectOnDeny("http://localhost:3000/cb"), true);
  assert.equal(shouldRedirectOnDeny("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(shouldRedirectOnDeny("https://widgets.example/cb"), false);
  assert.equal(shouldRedirectOnDeny("com.acme.widgets:/cb"), false);
});
