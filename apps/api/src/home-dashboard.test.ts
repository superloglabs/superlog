import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const {
  HOME_BUILTIN_TYPES,
  defaultHomeWidgets,
  homeBuiltinDefinition,
  homeLinkCreateSchema,
  dashboardRouteCanMutateDashboard,
  dashboardRouteCanWriteWidget,
} = await import("./dashboards-service.js");

test("every customizable home built-in keeps a definition even when it is not a default", () => {
  assert.deepEqual(
    HOME_BUILTIN_TYPES.map((type) => homeBuiltinDefinition(type).type),
    HOME_BUILTIN_TYPES,
  );
});

test("a new project home starts with the three operational pulse widgets", () => {
  const widgets = defaultHomeWidgets();

  assert.deepEqual(
    widgets.map((widget) => widget.type),
    ["setup_todos", "incoming_signals", "incident_count", "agent_pull_requests"],
  );
  assert.deepEqual(
    widgets.slice(1).map((widget) => widget.layout),
    [
      { x: 0, y: 5, w: 4, h: 5 },
      { x: 4, y: 5, w: 4, h: 5 },
      { x: 8, y: 5, w: 4, h: 5 },
    ],
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
