import assert from "node:assert/strict";
import test from "node:test";
import { planHomePulseRowUpgrade } from "./home-layout-upgrade.js";

test("existing home widgets move below the new pulse row", () => {
  const plan = planHomePulseRowUpgrade([
    {
      id: "setup",
      type: "setup_todos",
      layout: { x: 0, y: 0, w: 12, h: 5 },
    },
    {
      id: "existing-chart",
      type: "timeseries_count",
      layout: { x: 0, y: 0, w: 6, h: 4 },
    },
  ]);

  assert.deepEqual(plan.missingTypes, [
    "incoming_signals",
    "incident_count",
    "agent_pull_requests",
  ]);
  assert.deepEqual(plan.layoutUpdates, [
    { id: "existing-chart", layout: { x: 0, y: 5, w: 6, h: 4 } },
  ]);
});

test("existing pulse widgets are aligned across the top row", () => {
  const plan = planHomePulseRowUpgrade([
    {
      id: "signals",
      type: "incoming_signals",
      layout: { x: 7, y: 12, w: 4, h: 5 },
    },
    {
      id: "incidents",
      type: "incident_count",
      layout: { x: 0, y: 20, w: 8, h: 8 },
    },
    {
      id: "prs",
      type: "agent_pull_requests",
      layout: { x: 2, y: 3, w: 6, h: 4 },
    },
  ]);

  assert.deepEqual(plan.missingTypes, []);
  assert.deepEqual(plan.layoutUpdates, [
    { id: "signals", layout: { x: 0, y: 0, w: 4, h: 5 } },
    { id: "incidents", layout: { x: 4, y: 0, w: 4, h: 5 } },
    { id: "prs", layout: { x: 8, y: 0, w: 4, h: 5 } },
  ]);
});
