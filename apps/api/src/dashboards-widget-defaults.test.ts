import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dashboardWidgetCreateSchema,
  defaultWidgetLayout,
} from "./dashboards-service.js";

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

test("every default layout satisfies the widget layout schema", () => {
  for (const type of [
    "timeseries_count",
    "timeseries_metric",
    "trace_table",
    "log_table",
    "markdown",
  ] as const) {
    const parsed = dashboardWidgetCreateSchema.parse({
      type,
      title: "t",
      config: { filter: {} },
    });
    // layout is now optional — callers may omit it and get the standard size.
    assert.equal(parsed.layout, undefined);
  }
});

test("dashboardWidgetCreateSchema still accepts an explicit layout", () => {
  const parsed = dashboardWidgetCreateSchema.parse({
    type: "timeseries_count",
    title: "t",
    config: { filter: {} },
    layout: { x: 2, y: 0, w: 3, h: 3 },
  });
  assert.deepEqual(parsed.layout, { x: 2, y: 0, w: 3, h: 3 });
});
