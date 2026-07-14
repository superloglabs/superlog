import "./project-mcp-test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMcpFetch, strictProjectMcpFetch } from "./project-mcp-http.js";

test("project MCP requests use the guarded outbound connection boundary", async () => {
  const destinations: string[] = [];
  const safeFetch = createProjectMcpFetch(async (url) => {
    destinations.push(url.toString());
    return new Response(null, { status: 204 });
  });

  const response = await safeFetch("https://mcp.example/path", { method: "POST" });

  assert.equal(response.status, 204);
  assert.deepEqual(destinations, ["https://mcp.example/path"]);
});

test("project MCP requests reject non-HTTPS destinations before egress", async () => {
  let attempted = false;
  const safeFetch = createProjectMcpFetch(async () => {
    attempted = true;
    return new Response();
  });

  await assert.rejects(() => safeFetch("http://mcp.example/path"), /HTTPS/i);
  assert.equal(attempted, false);
});

test("project MCP egress stays fail-closed when private webhook delivery is enabled", async () => {
  const previous = process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS;
  process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "1";
  try {
    await assert.rejects(() => strictProjectMcpFetch("https://127.0.0.1/mcp"), /not allowed/i);
  } finally {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = previous ?? "";
  }
});
