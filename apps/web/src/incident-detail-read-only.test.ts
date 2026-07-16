import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  getIncidentDetailAccess,
  incidentPullRequestDiffPath,
  resolveIncidentPullRequestDiff,
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

test("a read-only consumer can provide its own live PR diff endpoint", () => {
  assert.equal(
    incidentPullRequestDiffPath("/api/staff/incidents/incident-1/pull-requests", "pr-1"),
    "/api/staff/incidents/incident-1/pull-requests/pr-1/diff",
  );
});

test("a PR without a stored patch uses the supplied live diff endpoint", () => {
  assert.deepEqual(
    resolveIncidentPullRequestDiff({
      patch: null,
      diffBasePath: "/api/staff/incidents/incident-1/pull-requests",
      pullRequestId: "pr-1",
    }),
    {
      kind: "remote",
      path: "/api/staff/incidents/incident-1/pull-requests/pr-1/diff",
    },
  );
});
