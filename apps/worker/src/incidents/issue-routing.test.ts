import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canQueueInvestigationForLockedIncident,
  decideIssueArrivalRouting,
} from "./issue-routing.js";

test("takes no agent action when grouping reuses an existing incident", () => {
  assert.equal(decideIssueArrivalRouting({ shouldInvestigate: false }), "none");
});

test("investigates only when intake opened a genuinely new incident", () => {
  assert.equal(decideIssueArrivalRouting({ shouldInvestigate: true }), "investigate");
});

test("a locked Incident must still be open before an investigation is queued", () => {
  assert.equal(canQueueInvestigationForLockedIncident("open"), true);
  assert.equal(canQueueInvestigationForLockedIncident("resolved"), false);
  assert.equal(canQueueInvestigationForLockedIncident("merged"), false);
  assert.equal(canQueueInvestigationForLockedIncident(null), false);
});
