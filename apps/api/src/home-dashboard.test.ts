import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const {
  defaultHomeWidgets,
  homeLinkCreateSchema,
  dashboardRouteCanMutateDashboard,
  dashboardRouteCanWriteWidget,
} = await import("./dashboards-service.js");

test("a new project home preserves the three existing overview sections as widgets", () => {
  const widgets = defaultHomeWidgets();

  assert.deepEqual(
    widgets.map((widget) => widget.type),
    ["setup_todos", "active_incidents", "service_map"],
  );
  assert.equal(
    widgets.every((widget) => (widget.layout?.w ?? 0) >= 6),
    true,
  );
});

test("home links require a safe absolute web URL", () => {
  assert.doesNotThrow(() =>
    homeLinkCreateSchema.parse({
      title: "Runbook",
      url: "https://docs.example.com/runbook",
      description: "Primary response guide",
    }),
  );
  assert.throws(() => homeLinkCreateSchema.parse({ title: "Unsafe", url: "javascript:alert(1)" }));
});

test("generic dashboard routes cannot create or edit home-only widgets", () => {
  assert.equal(dashboardRouteCanWriteWidget({ requestedType: "link" }), false);
  assert.equal(dashboardRouteCanWriteWidget({ existingType: "link" }), false);
  assert.equal(dashboardRouteCanWriteWidget({ requestedType: "active_incidents" }), false);
  assert.equal(dashboardRouteCanWriteWidget({ requestedType: "timeseries_count" }), true);
});

test("generic dashboard routes cannot mutate the home dashboard", () => {
  assert.equal(dashboardRouteCanMutateDashboard({ isHome: true }), false);
  assert.equal(dashboardRouteCanMutateDashboard({ isHome: false }), true);
});
