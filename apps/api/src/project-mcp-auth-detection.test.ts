import "./project-mcp-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectProjectMcpAuth } from "./project-mcp-auth-detection.js";

test("MCP auth detection recognizes standards-based OAuth authorization code servers", async () => {
  const http = {
    discover: async () => ({
      authorizationServer: "https://auth.granola.example",
      authorizationEndpoint: "https://auth.granola.example/authorize",
      tokenEndpoint: "https://auth.granola.example/token",
      registrationEndpoint: "https://auth.granola.example/register",
      resource: "https://mcp.granola.example/mcp",
      codeChallengeMethods: ["S256"],
      grantTypes: ["authorization_code", "refresh_token"],
    }),
  };

  assert.deepEqual(await detectProjectMcpAuth("https://mcp.granola.example/mcp", http), {
    type: "oauth",
    grantType: "authorization_code",
    supportsDynamicRegistration: true,
  });
});

test("MCP auth detection stays unknown when the server does not publish OAuth metadata", async () => {
  const result = await detectProjectMcpAuth("https://mcp.example/mcp", {
    discover: async () => {
      throw new Error("OAuth metadata discovery failed");
    },
  });

  assert.deepEqual(result, { type: "unknown" });
});

test("MCP auth detection rejects authorization code servers without PKCE S256", async () => {
  const result = await detectProjectMcpAuth("https://mcp.example/mcp", {
    discover: async () => ({
      codeChallengeMethods: ["plain"],
      grantTypes: ["authorization_code"],
      registrationEndpoint: "https://auth.example/register",
    }),
  });

  assert.deepEqual(result, { type: "unknown" });
});
