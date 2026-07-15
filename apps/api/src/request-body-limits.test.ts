import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { mountApiRequestSecurity, requestBodyLimit } from "./request-body-limits.js";

test("request body limits reject a declared oversized payload before the handler runs", async () => {
  let handled = false;
  const app = new Hono();
  app.use("*", requestBodyLimit(8));
  app.post("/", async (c) => {
    handled = true;
    return c.json(await c.req.json());
  });

  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "9" },
    body: JSON.stringify({ x: 1 }),
  });

  assert.equal(response.status, 413);
  assert.equal(handled, false);
  assert.deepEqual(await response.json(), { error: "payload too large" });
});

test("API body-limit errors preserve browser-visible CORS headers", async () => {
  let handled = false;
  const app = new Hono();
  mountApiRequestSecurity(app, ["https://app.example"]);
  app.post("/api/upload", (c) => {
    handled = true;
    return c.json({ ok: true });
  });

  const response = await app.request("/api/upload", {
    method: "POST",
    headers: {
      "content-length": String(2 * 1024 * 1024 + 1),
      "content-type": "application/json",
      origin: "https://app.example",
    },
    body: "{}",
  });

  assert.equal(response.status, 413);
  assert.equal(handled, false);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example");
  assert.deepEqual(await response.json(), { error: "payload too large" });
});
