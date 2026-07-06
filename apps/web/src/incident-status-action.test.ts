import assert from "node:assert/strict";
import test from "node:test";
import { getIncidentStatusActions } from "./incident-status-action.ts";

test("open incidents offer problem-resolved and not-an-issue", () => {
  assert.deepEqual(getIncidentStatusActions("open"), [
    {
      label: "Problem resolved",
      targetStatus: "resolved",
      resolution: "problem_resolved",
      variant: "secondary",
    },
    {
      label: "Not an issue",
      targetStatus: "resolved",
      resolution: "not_an_issue",
      variant: "ghost",
    },
  ]);
});

test("closed incidents can be reopened", () => {
  assert.deepEqual(getIncidentStatusActions("resolved"), [
    { label: "Reopen incident", targetStatus: "open", variant: "ghost" },
  ]);
});
