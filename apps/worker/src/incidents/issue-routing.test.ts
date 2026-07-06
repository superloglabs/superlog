import assert from "node:assert/strict";
import { test } from "node:test";
import { decideIssueArrivalRouting } from "./issue-routing.js";

const base = {
  createdIncident: false,
  suppressed: false,
  latestRunIsTerminal: true,
};

test("steers when a new signature joins an already-investigated open incident", () => {
  assert.equal(decideIssueArrivalRouting(base), "steer");
});

test("investigates a brand-new incident (nothing to steer)", () => {
  assert.equal(decideIssueArrivalRouting({ ...base, createdIncident: true }), "investigate");
});

test("investigates when there is no terminal run yet (none/active/dormant)", () => {
  assert.equal(decideIssueArrivalRouting({ ...base, latestRunIsTerminal: false }), "investigate");
});

test("does not steer while suppressed by a fixed_in_current_code cooldown", () => {
  assert.equal(decideIssueArrivalRouting({ ...base, suppressed: true }), "investigate");
});
