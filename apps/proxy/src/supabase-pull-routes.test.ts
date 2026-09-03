import { strict as assert } from "node:assert";
import test from "node:test";
import { Hono } from "hono";
import { mountSupabaseMetricsPullRoute } from "./supabase-pull-routes.js";

test("Supabase pull metrics require an ingest key before forwarding", async () => {
  const calls: string[] = [];
  const app = new Hono();
  mountSupabaseMetricsPullRoute(app, {
    async validateIngestKey(c, next) {
      calls.push("authenticate");
      await next();
    },
    async forward(c) {
      calls.push("forward");
      return c.json({ ok: true });
    },
  });

  const response = await app.request("/supabase/pull/metrics", { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["authenticate", "forward"]);
});
