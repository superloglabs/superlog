import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAutomationSettings } from "./schema.js";

test("resolve-time Linear ticket creation is opt-in", () => {
  assert.equal(projectAutomationSettings.createLinearTicketOnResolve.default, false);
});

test("quiet incident auto-resolution can be disabled per project", () => {
  assert.equal(projectAutomationSettings.autoResolveStaleIncidentsEnabled.default, true);
});
