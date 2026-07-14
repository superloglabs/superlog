import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GoogleMonitoringClient } from "./monitoring-client.js";

test("Cloud Monitoring reads explicitly bill quota to the integration project", async () => {
  let request: { url: URL; headers: Headers } | null = null;
  const client = new GoogleMonitoringClient({
    integrationProjectId: "superlog-observability",
    accessToken: async () => "reader-token",
    fetchImpl: async (input, init) => {
      request = {
        url: new URL(String(input)),
        headers: new Headers(init?.headers),
      };
      return Response.json({ timeSeries: [] });
    },
  });

  await client.listTimeSeries({
    gcpProjectId: "acme-production",
    metricType: "compute.googleapis.com/instance/cpu/utilization",
    startTime: new Date("2026-07-13T11:50:00Z"),
    endTime: new Date("2026-07-13T12:00:00Z"),
    pageSize: 1000,
  });

  assert.ok(request);
  const captured = request as { url: URL; headers: Headers };
  assert.equal(captured.headers.get("x-goog-user-project"), "superlog-observability");
  assert.equal(captured.headers.get("authorization"), "Bearer reader-token");
  assert.match(captured.url.pathname, /projects\/acme-production\/timeSeries$/);
  assert.equal(
    captured.url.searchParams.get("filter"),
    'metric.type = "compute.googleapis.com/instance/cpu/utilization"',
  );
  assert.equal(captured.url.searchParams.get("pageSize"), "1000");
});
