import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INTERNAL_INCIDENT_EVENT_KIND_PREFIX,
  INTERNAL_INCIDENT_EVENT_KIND_SQL_PATTERN,
  isVisibleIncidentEventKind,
} from "./incident-event-visibility.js";

test("internal receipt events stay out of user-visible incident history", () => {
  assert.equal(INTERNAL_INCIDENT_EVENT_KIND_PREFIX, "internal_");
  assert.equal(INTERNAL_INCIDENT_EVENT_KIND_SQL_PATTERN, "internal\\_%");
  assert.equal(isVisibleIncidentEventKind("internal_agent_outcome_action_receipt"), false);
  assert.equal(isVisibleIncidentEventKind("internal_agent_outcome_pr_delivery"), false);
  assert.equal(isVisibleIncidentEventKind("agent.tool"), true);
  assert.equal(isVisibleIncidentEventKind("incident_resolved"), true);
});
