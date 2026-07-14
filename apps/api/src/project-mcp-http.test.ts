import "./project-mcp-test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMcpFetch } from "./project-mcp-http.js";

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
