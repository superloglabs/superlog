import { strict as assert } from "node:assert";
import { test } from "node:test";

// demo.ts transitively imports the db client, which throws at import time
// without a connection string. Set a dummy URL before the dynamic import (the
// postgres client connects lazily, so these pure-function tests never open a
// socket). Same pattern as alerts-service.test.ts / incidents/detail.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { demoProjectId, isDemoBlockedWrite, pickReadProjectId } = await import("./demo.js");

test("demoProjectId only accepts a canonical UUID (fail-safe on misconfig)", () => {
  const prev = process.env.DEMO_PROJECT_ID;
  try {
    process.env.DEMO_PROJECT_ID = "47966735-416b-4f3d-8ed1-6a96379d75fd";
    assert.equal(demoProjectId(), "47966735-416b-4f3d-8ed1-6a96379d75fd");
    process.env.DEMO_PROJECT_ID = "  47966735-416b-4f3d-8ed1-6a96379d75fd  ";
    assert.equal(demoProjectId(), "47966735-416b-4f3d-8ed1-6a96379d75fd");
    for (const bad of ["", "   ", "not-a-uuid", "47966735", "demo-project"]) {
      process.env.DEMO_PROJECT_ID = bad;
      assert.equal(demoProjectId(), undefined, `"${bad}" should disable demo mode`);
    }
    process.env.DEMO_PROJECT_ID = undefined;
    assert.equal(demoProjectId(), undefined);
  } finally {
    if (prev === undefined) process.env.DEMO_PROJECT_ID = undefined;
    else process.env.DEMO_PROJECT_ID = prev;
  }
});

test("pickReadProjectId substitutes the demo project for a fresh, un-ingested project", () => {
  assert.deepEqual(
    pickReadProjectId({ realProjectId: "real-1", demoProjectId: "demo-x", hasIngested: false }),
    { id: "demo-x", demo: true },
  );
});

test("pickReadProjectId returns the real project once it has ingested", () => {
  assert.deepEqual(
    pickReadProjectId({ realProjectId: "real-1", demoProjectId: "demo-x", hasIngested: true }),
    { id: "real-1", demo: false },
  );
});

test("pickReadProjectId is a no-op when demo mode is off (no DEMO_PROJECT_ID)", () => {
  assert.deepEqual(
    pickReadProjectId({ realProjectId: "real-1", demoProjectId: undefined, hasIngested: false }),
    { id: "real-1", demo: false },
  );
});

test("pickReadProjectId never overlays the demo project onto itself", () => {
  assert.deepEqual(
    pickReadProjectId({ realProjectId: "demo-x", demoProjectId: "demo-x", hasIngested: false }),
    { id: "demo-x", demo: false },
  );
});

test("isDemoBlockedWrite blocks writes to demo-overlaid resources", () => {
  for (const [method, path] of [
    ["POST", "/api/projects/p1/dashboards"],
    ["PATCH", "/api/projects/p1/dashboards/d1/layout"],
    ["DELETE", "/api/projects/p1/dashboards/d1/widgets/w1"],
    ["PATCH", "/api/projects/p1/incidents/inc1"],
    ["POST", "/api/projects/p1/incidents/inc1/agent-run/restart"],
    ["POST", "/api/projects/p1/alerts"],
    ["DELETE", "/api/projects/p1/alerts/a1"],
    ["POST", "/api/projects/p1/issues/i1/silence"],
  ] as const) {
    assert.equal(isDemoBlockedWrite({ method, path }), true, `${method} ${path} should be blocked`);
  }
});

test("isDemoBlockedWrite never blocks the install / integration path (how users leave demo)", () => {
  for (const [method, path] of [
    ["POST", "/api/projects/p1/keys"],
    ["DELETE", "/api/projects/p1/keys/k1"],
    ["PATCH", "/api/projects/p1/automation"],
    ["POST", "/api/projects/p1/cloud-connections"],
    ["POST", "/api/projects/p1/cloud-connections/c1/sync"],
    ["POST", "/api/projects/p1/webhooks"],
    ["PUT", "/api/projects/p1/slack-route"],
    ["POST", "/api/projects/p1/symbolication/log"],
  ] as const) {
    assert.equal(
      isDemoBlockedWrite({ method, path }),
      false,
      `${method} ${path} should be allowed`,
    );
  }
});

test("isDemoBlockedWrite never blocks POST-for-read endpoints (explorer / previews)", () => {
  for (const path of [
    "/api/projects/p1/explore/logs",
    "/api/projects/p1/explore/traces",
    "/api/projects/p1/explore/metric-series",
    "/api/projects/p1/issues/lookup",
    "/api/projects/p1/issue-filter/preview",
    "/api/projects/p1/alerts/preview",
  ]) {
    assert.equal(
      isDemoBlockedWrite({ method: "POST", path }),
      false,
      `POST ${path} is a read and must stay allowed`,
    );
  }
});

test("isDemoBlockedWrite ignores non-mutating methods and non-project routes", () => {
  assert.equal(isDemoBlockedWrite({ method: "GET", path: "/api/projects/p1/dashboards" }), false);
  assert.equal(isDemoBlockedWrite({ method: "POST", path: "/api/me/orgs" }), false);
});

// Regression guard / living checklist: EVERY mutating /api/projects/:projectId/*
// route in the codebase, classified as block (mutates demo-overlaid data, must be
// 403 in demo mode) or allow (install / integration path or POST-for-read — must
// stay open so a user can leave demo mode). If you add a mutating project route,
// add it here with its intent. Keep in sync with the route inventory in index.ts
// (grep: `.(post|put|patch|delete)("/api/projects/:projectId`).
test("isDemoBlockedWrite matches the full mutating project-route inventory", () => {
  const ROUTES: Array<{ method: string; path: string; block: boolean }> = [
    // demo-overlaid data → blocked
    { method: "POST", path: "/api/projects/p1/dashboards", block: true },
    { method: "PATCH", path: "/api/projects/p1/dashboards/d1", block: true },
    { method: "DELETE", path: "/api/projects/p1/dashboards/d1", block: true },
    { method: "POST", path: "/api/projects/p1/dashboards/d1/widgets", block: true },
    { method: "PATCH", path: "/api/projects/p1/dashboards/d1/widgets/w1", block: true },
    { method: "DELETE", path: "/api/projects/p1/dashboards/d1/widgets/w1", block: true },
    { method: "PATCH", path: "/api/projects/p1/dashboards/d1/layout", block: true },
    { method: "PATCH", path: "/api/projects/p1/incidents/i1", block: true },
    { method: "POST", path: "/api/projects/p1/incidents/i1/agent-run/restart", block: true },
    { method: "POST", path: "/api/projects/p1/incidents/i1/agent-run/retry-pr", block: true },
    { method: "POST", path: "/api/projects/p1/incidents/i1/pull-requests/pr1/merge", block: true },
    { method: "POST", path: "/api/projects/p1/alerts", block: true },
    { method: "PATCH", path: "/api/projects/p1/alerts/a1", block: true },
    { method: "DELETE", path: "/api/projects/p1/alerts/a1", block: true },
    { method: "POST", path: "/api/projects/p1/alerts/a1/test", block: true },
    { method: "POST", path: "/api/projects/p1/issues/i1/silence", block: true },
    { method: "POST", path: "/api/projects/p1/issues/i1/unsilence", block: true },
    // Home configuration belongs to the real project even while telemetry reads use demo data.
    { method: "PUT", path: "/api/projects/p1/home/builtins/setup_todos", block: false },
    { method: "POST", path: "/api/projects/p1/home/widgets", block: false },
    { method: "POST", path: "/api/projects/p1/home/links", block: false },
    { method: "PATCH", path: "/api/projects/p1/home/layout", block: false },
    { method: "DELETE", path: "/api/projects/p1/home/items/w1", block: false },
    // install / integration path → must stay OPEN (how a user leaves demo mode)
    { method: "POST", path: "/api/projects/p1/keys", block: false },
    { method: "DELETE", path: "/api/projects/p1/keys/k1", block: false },
    { method: "PATCH", path: "/api/projects/p1/automation", block: false },
    { method: "POST", path: "/api/projects/p1/cloud-connections", block: false },
    { method: "DELETE", path: "/api/projects/p1/cloud-connections/c1", block: false },
    { method: "POST", path: "/api/projects/p1/cloud-connections/c1/sync", block: false },
    { method: "POST", path: "/api/projects/p1/cloud-connections/c1/verify", block: false },
    { method: "POST", path: "/api/projects/p1/cloud-connections/c1/logs-stream", block: false },
    { method: "POST", path: "/api/projects/p1/cloud-connections/c1/metrics-stream", block: false },
    { method: "POST", path: "/api/projects/p1/webhooks", block: false },
    { method: "PATCH", path: "/api/projects/p1/webhooks/h1", block: false },
    { method: "DELETE", path: "/api/projects/p1/webhooks/h1", block: false },
    { method: "POST", path: "/api/projects/p1/webhooks/h1/rotate-secret", block: false },
    { method: "POST", path: "/api/projects/p1/webhooks/h1/test", block: false },
    { method: "PUT", path: "/api/projects/p1/slack-route", block: false },
    { method: "DELETE", path: "/api/projects/p1/slack-route", block: false },
    { method: "POST", path: "/api/projects/p1/symbolication/log", block: false },
    // POST-for-read (query in body) → must stay OPEN
    { method: "POST", path: "/api/projects/p1/explore/logs", block: false },
    { method: "POST", path: "/api/projects/p1/explore/traces", block: false },
    { method: "POST", path: "/api/projects/p1/explore/traces-aggregated", block: false },
    { method: "POST", path: "/api/projects/p1/explore/series", block: false },
    { method: "POST", path: "/api/projects/p1/explore/metric-series", block: false },
    { method: "POST", path: "/api/projects/p1/explore/metrics", block: false },
    { method: "POST", path: "/api/projects/p1/issues/lookup", block: false },
    { method: "POST", path: "/api/projects/p1/issue-filter/preview", block: false },
    { method: "POST", path: "/api/projects/p1/alerts/preview", block: false },
    { method: "POST", path: "/api/projects/p1/alerts/preview-series", block: false },
  ];
  for (const r of ROUTES) {
    assert.equal(
      isDemoBlockedWrite({ method: r.method, path: r.path }),
      r.block,
      `${r.method} ${r.path} expected block=${r.block}`,
    );
  }
});

test("isDemoBlockedWrite is not fooled by path/method variations", () => {
  // trailing slash, query string, lowercase method, extra depth on a blocked seg
  assert.equal(isDemoBlockedWrite({ method: "post", path: "/api/projects/p1/dashboards" }), true);
  assert.equal(
    isDemoBlockedWrite({ method: "POST", path: "/api/projects/p1/dashboards?x=1" }),
    true,
  );
  assert.equal(
    isDemoBlockedWrite({ method: "DELETE", path: "/api/projects/p1/incidents/i1/anything" }),
    true,
  );
  // an explore path with a query string is still a read
  assert.equal(
    isDemoBlockedWrite({ method: "POST", path: "/api/projects/p1/explore/logs?limit=5" }),
    false,
  );
});
