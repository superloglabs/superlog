import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mountApiRequestSecurity } from "./request-body-limits.js";
import { hasDotSegment } from "./request-target.js";

// Sends the request target exactly as given; Node's client does not resolve
// dot segments.
function get(port: number, target: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", path: target, port }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ body, status: response.statusCode ?? 0 }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("finds literal and percent-encoded dot segments", () => {
  for (const target of [
    "/mcp/../health",
    "/mcp/%2e%2e/health",
    "/mcp/%2E%2E/health",
    "/mcp/.%2e/health",
    "/mcp/%2e./health",
    "/api/./auth/sign-in/email",
    "/api/%2e/auth/sign-in/email",
    "/api/v1\\..\\auth/sign-in/email",
    "/../health",
    "/health/..",
    "/health/%2e?x=1",
  ]) {
    assert.equal(hasDotSegment(target), true, target);
  }
  for (const target of [
    "/",
    "/health",
    "/health?next=/../x",
    "/api/projects/a..b",
    "/.well-known/oauth-authorization-server",
    "/mcp/%252e%252e/health",
  ]) {
    assert.equal(hasDotSegment(target), false, target);
  }
});

test("the API rejects a request whose path resolves somewhere else", async () => {
  const app = new Hono();
  mountApiRequestSecurity(app, ["https://app.example"]);
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/auth/session", (c) => c.json({ ok: true }));

  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    for (const target of ["/mcp/%2e%2e/health", "/mcp/../health", "/x/%2E%2E/api/auth/session"]) {
      const response = await get(port, target);
      assert.equal(response.status, 400, target);
      assert.deepEqual(JSON.parse(response.body), { error: "invalid request path" }, target);
    }
    assert.equal((await get(port, "/health")).status, 200);
    assert.equal((await get(port, "/api/auth/session")).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
