import assert from "node:assert/strict";
import test from "node:test";
import {
  homeWidgetMinHeight,
  homeWidgetPresentation,
  splitHomeWidgets,
} from "./home-layout.ts";

test("active incidents use the home tile as their only shell", () => {
  const presentation = homeWidgetPresentation("active_incidents");

  assert.equal(presentation.bodyPadding, false);
  assert.equal(presentation.innerShell, false);
  assert.equal(presentation.defaultHeight, 5);
});

test("active incidents floor at five rows so three incidents show before scrolling", () => {
  assert.equal(homeWidgetMinHeight("active_incidents"), 5);
  assert.equal(homeWidgetMinHeight("link"), 2);
  assert.equal(homeWidgetMinHeight("incoming_signals"), 3);
});

test("setup stays outside the framed home widget grid", () => {
  const widgets = [
    { id: "setup", type: "setup_todos" as const },
    { id: "chart", type: "timeseries_count" as const },
    { id: "logs", type: "log_table" as const },
  ];

  const result = splitHomeWidgets(widgets);

  assert.equal(result.setup?.id, "setup");
  assert.deepEqual(
    result.grid.map((widget) => widget.id),
    ["chart", "logs"],
  );
});
