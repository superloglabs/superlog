import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildApiSpanAttributes, normalizeHttpRoute } from "./http-observability.js";

test("normalizeHttpRoute collapses dynamic ids while keeping useful endpoint names", () => {
  assert.equal(
    normalizeHttpRoute("/api/projects/018f34d2-9f91-76cc-9e13-34f3287ff03d/explore/traces"),
    "/api/projects/:id/explore/traces",
  );
  assert.equal(
    normalizeHttpRoute("/api/incidents/inc_01jwj3c9j7q93w2p50ab4t72w3/events"),
    "/api/incidents/:id/events",
  );
  assert.equal(normalizeHttpRoute("/api/me?tab=settings"), "/api/me");
});

test("buildApiSpanAttributes adds tenant and normalized endpoint attributes for server spans", () => {
  assert.deepEqual(
    buildApiSpanAttributes({
      method: "post",
      path: "/api/projects/project_123/explore/logs?limit=50",
      routePath: "/api/*",
      statusCode: 201,
      orgId: "org_123",
      userId: "user_123",
    }),
    {
      "http.request.method": "POST",
      "http.route": "/api/projects/:id/explore/logs",
      "superlog.endpoint": "/api/projects/:id/explore/logs",
      "http.response.status_code": 201,
      "http.response.status_class": "2xx",
      "tenant.org.id": "org_123",
      "enduser.id": "user_123",
      "tenant.project.id": "project_123",
    },
  );
});

test("buildApiSpanAttributes extracts project ids from all project-scoped API route families", () => {
  for (const path of [
    "/api/projects/project_123/explore/logs",
    "/api/org/projects/project_123/keys",
    "/api/v1/projects/project_123/logs",
  ]) {
    assert.equal(
      buildApiSpanAttributes({
        method: "get",
        path,
        statusCode: 200,
      })["tenant.project.id"],
      "project_123",
    );
  }
});
