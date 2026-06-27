import assert from "node:assert/strict";
import test from "node:test";
import type { Widget } from "./types.ts";
import {
  buildWidgetConfig,
  emptyWidgetForm,
  formFromWidget,
  generateTitle,
  widgetTypeFor,
} from "./widget-config.ts";

function widget(partial: Partial<Widget>): Widget {
  return {
    id: "w1",
    dashboardId: "d1",
    type: "timeseries_count",
    title: "t",
    config: { filter: {} },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    position: 0,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...partial,
  };
}

test("widgetTypeFor maps kind+source to a widget type", () => {
  assert.equal(widgetTypeFor("note", "logs"), "markdown");
  assert.equal(widgetTypeFor("chart", "metric"), "timeseries_metric");
  assert.equal(widgetTypeFor("chart", "logs"), "timeseries_count");
  assert.equal(widgetTypeFor("chart", "traces"), "timeseries_count");
  assert.equal(widgetTypeFor("table", "traces"), "trace_table");
  assert.equal(widgetTypeFor("table", "logs"), "log_table");
});

test("formFromWidget derives kind/source for each widget type", () => {
  assert.equal(formFromWidget(widget({ type: "markdown" })).kind, "note");
  assert.equal(formFromWidget(widget({ type: "trace_table" })).kind, "table");
  assert.equal(formFromWidget(widget({ type: "trace_table" })).source, "traces");
  assert.equal(formFromWidget(widget({ type: "log_table" })).source, "logs");
  assert.equal(formFromWidget(widget({ type: "timeseries_metric" })).source, "metric");
  // count widget's source comes from config
  assert.equal(
    formFromWidget(widget({ type: "timeseries_count", config: { filter: {}, source: "traces" } }))
      .source,
    "traces",
  );
});

test("round-trips a fully specified count widget config", () => {
  const w = widget({
    type: "timeseries_count",
    config: {
      source: "logs",
      filter: { resourceAttrs: [{ key: "service.name", value: "api", op: "neq" }] },
      groupBy: "service.name",
      limit: 7,
      chartType: "bar",
      showXAxis: false,
      showYAxis: true,
      showLegend: true,
      legendPosition: "bottom",
    },
  });
  assert.deepEqual(buildWidgetConfig(formFromWidget(w)), w.config);
});

test("round-trips a fully specified metric widget config", () => {
  const w = widget({
    type: "timeseries_metric",
    config: {
      filter: { resourceAttrs: [{ key: "env", value: "prod" }] },
      groupBy: "attr:gen_ai.request.model",
      metricName: "gen_ai.cost",
      aggregation: "p95",
      limit: 5,
      chartType: "line",
      showXAxis: true,
      showYAxis: true,
      showLegend: false,
    },
  });
  assert.deepEqual(buildWidgetConfig(formFromWidget(w)), w.config);
});

test("round-trips a metric widget with a unit", () => {
  const w = widget({
    type: "timeseries_metric",
    config: {
      filter: {},
      metricName: "ingest.latency",
      aggregation: "avg",
      unit: "duration_ms",
      chartType: "line",
      showXAxis: true,
      showYAxis: true,
      showLegend: true,
      legendPosition: "side",
    },
  });
  assert.deepEqual(buildWidgetConfig(formFromWidget(w)), w.config);
});

test("unit 'none' is omitted from config", () => {
  const form = {
    ...emptyWidgetForm(),
    kind: "chart" as const,
    source: "logs" as const,
    unit: "none" as const,
  };
  assert.equal(buildWidgetConfig(form).unit, undefined);
});

test("round-trips a markdown note", () => {
  const w = widget({ type: "markdown", config: { filter: {}, markdown: "# Hi" } });
  assert.deepEqual(buildWidgetConfig(formFromWidget(w)), w.config);
});

test("round-trips a table with a row limit", () => {
  const w = widget({
    type: "log_table",
    config: { filter: { resourceAttrs: [{ key: "k", value: "v" }] }, limit: 100 },
  });
  assert.deepEqual(buildWidgetConfig(formFromWidget(w)), w.config);
});

test("clearing group-by drops the series limit from the config", () => {
  const form = { ...emptyWidgetForm(), kind: "chart" as const, source: "logs" as const };
  const cfg = buildWidgetConfig(form);
  assert.equal(cfg.groupBy, undefined);
  assert.equal(cfg.limit, undefined);
});

test("metric source is not persisted as config.source", () => {
  // config.source only distinguishes logs vs traces for count widgets
  const form = { ...emptyWidgetForm(), kind: "chart" as const, source: "metric" as const };
  assert.equal(buildWidgetConfig(form).source, undefined);
});

test("aggregation 'auto' is omitted from config", () => {
  const form = {
    ...emptyWidgetForm(),
    kind: "chart" as const,
    source: "metric" as const,
    metricName: "m",
    aggregation: "auto" as const,
  };
  assert.equal(buildWidgetConfig(form).aggregation, undefined);
});

test("generateTitle reflects metric + group-by", () => {
  assert.equal(
    generateTitle({
      kind: "chart",
      source: "metric",
      metricName: "latency",
      groupBy: "service.name",
      attrs: [],
      markdown: "",
    }),
    "latency by service.name",
  );
});
