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

test("read-only PRs always use supplied data instead of the connected loader", () => {
  assert.equal(
    shouldUsePreloadedPullRequests({ readOnly: true, pullRequestsProvided: false }),
    true,
  );
  assert.equal(
    shouldUsePreloadedPullRequests({ readOnly: false, pullRequestsProvided: true }),
    true,
  );
  assert.equal(
    shouldUsePreloadedPullRequests({ readOnly: false, pullRequestsProvided: false }),
    false,
  );
});
