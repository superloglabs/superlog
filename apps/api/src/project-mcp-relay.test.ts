import "./project-mcp-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectMcpServerRepository } from "@superlog/db";
import { Hono } from "hono";
import { mountProjectMcpRelayPublic } from "./project-mcp-relay.js";

test("the MCP relay authenticates the session and injects only the configured API-key header", async () => {
  const upstreamRequests: Request[] = [];
  const repository = {
    get: async () => ({
      id: "server-1",
      projectId: "project-1",
      name: "internal",
      url: "https://upstream.example/mcp",
      enabled: true,
      auth: {
        type: "api_key",
        headerName: "X-API-Key",
        key: "upstream-secret",
        relayToken: "relay-secret",
      },
    }),
  } as unknown as ProjectMcpServerRepository;
  const app = new Hono();
  mountProjectMcpRelayPublic(app, {
    repository,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      upstreamRequests.push(request);
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "upstream-session",
        },
      });
    },
  });

  const response = await app.request("/api/agent-mcp-relay/project-1/server-1", {
    method: "POST",
    headers: {
      authorization: "Bearer relay-secret",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      cookie: "must-not-forward=1",
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), "upstream-session");
  const upstream = upstreamRequests[0];
  assert.equal(upstream?.headers.get("x-api-key"), "upstream-secret");
  assert.equal(upstream?.headers.get("authorization"), null);
  assert.equal(upstream?.headers.get("cookie"), null);
  assert.equal(upstream?.headers.get("mcp-protocol-version"), "2025-11-25");
});
