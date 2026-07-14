import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  getIncidentDetailAccess,
  shouldUsePreloadedPullRequests,
} from "./incidents/incident-detail-access.ts";

test("read-only incident detail denies every customer-data mutation", () => {
  assert.deepEqual(getIncidentDetailAccess(true), {
    canUpdateStatus: false,
    canSubmitFeedback: false,
    canChat: false,
    canDecideResolutionProposal: false,
    canMergePullRequest: false,
  });
});

test("interactive incident detail retains every product action", () => {
  assert.deepEqual(getIncidentDetailAccess(false), {
    canUpdateStatus: true,
    canSubmitFeedback: true,
    canChat: true,
    canDecideResolutionProposal: true,
    canMergePullRequest: true,
  });
});

test("only read-only consumers render PRs straight from supplied data", () => {
  assert.equal(shouldUsePreloadedPullRequests({ readOnly: true }), true);
  // The product detail preloads PRs for tab visibility, but its panel must
  // stay on the connected loader so merge keeps working.
  assert.equal(shouldUsePreloadedPullRequests({ readOnly: false }), false);
});
