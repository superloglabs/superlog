import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dashboardWidgetCreateSchema,
  dashboardWidgetLayoutSchema,
  dashboardWidgetTypeSchema,
  defaultWidgetLayout,
} from "./dashboards-service.js";

const ALL_TYPES = dashboardWidgetTypeSchema.options;

test("defaultWidgetLayout returns the standard size per widget type", () => {
  // Chart widgets default to half-width on the 12-column grid.
  assert.deepEqual(defaultWidgetLayout("timeseries_count"), { x: 0, y: 9999, w: 6, h: 4 });
  assert.deepEqual(defaultWidgetLayout("timeseries_metric"), { x: 0, y: 9999, w: 6, h: 4 });
  // Tables default to full-width.
  assert.deepEqual(defaultWidgetLayout("trace_table"), { x: 0, y: 9999, w: 12, h: 6 });
  assert.deepEqual(defaultWidgetLayout("log_table"), { x: 0, y: 9999, w: 12, h: 6 });
  // Markdown defaults to a small third-width note.
  assert.deepEqual(defaultWidgetLayout("markdown"), { x: 0, y: 9999, w: 4, h: 5 });
});

test("every default layout is valid against the widget layout schema", () => {
  for (const type of ALL_TYPES) {
    // The schema is the single source of truth for the 12-column grid; every
    // default we hand back must pass it.
    assert.doesNotThrow(() => dashboardWidgetLayoutSchema.parse(defaultWidgetLayout(type)));
  }
});

test("dashboardWidgetCreateSchema makes layout optional", () => {
  for (const type of ALL_TYPES) {
    const parsed = dashboardWidgetCreateSchema.parse({ type, title: "t", config: { filter: {} } });
    // Omitted layout — the service applies the standard size at insert time.
    assert.equal(parsed.layout, undefined);
  }
});

test("dashboardWidgetCreateSchema still accepts an explicit in-grid layout", () => {
  const parsed = dashboardWidgetCreateSchema.parse({
    type: "timeseries_count",
    title: "t",
    config: { filter: {} },
    layout: { x: 2, y: 0, w: 3, h: 3 },
  });
  assert.deepEqual(parsed.layout, { x: 2, y: 0, w: 3, h: 3 });
});

test("the layout schema rejects spans wider than the 12-column grid", () => {
  assert.throws(() => dashboardWidgetLayoutSchema.parse({ x: 0, y: 0, w: 48, h: 4 }));
  assert.throws(() => dashboardWidgetLayoutSchema.parse({ x: 12, y: 0, w: 1, h: 4 }));
});
