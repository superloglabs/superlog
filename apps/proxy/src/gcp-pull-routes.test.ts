import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { mountGcpMetricsPullRoute } from "./gcp-pull-routes.js";

test("the GCP metrics pull route authenticates before forwarding", async () => {
  const app = new Hono();
  let forwarded = false;
  mountGcpMetricsPullRoute(app, {
    async validateIngestKey(c) {
      return c.json({ error: "missing api key" }, 401);
    },
    async forward() {
      forwarded = true;
      return new Response(null, { status: 200 });
    },
  });

  const response = await app.request("/gcp/pull/metrics", { method: "POST" });

  assert.equal(response.status, 401);
  assert.equal(forwarded, false);
});
