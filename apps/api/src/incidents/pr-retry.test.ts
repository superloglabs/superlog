import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import { getPrDeliveryRetryEligibility } from "./pr-retry.js";

test("pr delivery retry is allowed for failed pr_open_failed runs with a pending reusable patch", () => {
  const result: AgentRunResult = {
    state: "failed",
    summary: "Failed to validate or open the PR.",
    failureReason: "pr_open_failed",
    pr: {
      selectedRepoFullName: "acme/api",
      branchName: "superlog/fix-api",
      baseBranch: "main",
      patch: "diff --git a/a b/a\n",
      validationPassed: true,
      openStatus: "pending",
    },
  };

  assert.deepEqual(
    getPrDeliveryRetryEligibility({
      state: "failed",
      failureReason: "pr_open_failed",
      result,
    }),
    { canRetry: true },
  );
});

test("pr delivery retry is denied when no patch can be reused", () => {
  const result: AgentRunResult = {
    state: "failed",
    summary: "Failed to validate or open the PR.",
    failureReason: "pr_open_failed",
    pr: {
      selectedRepoFullName: "acme/api",
      branchName: "superlog/fix-api",
      baseBranch: "main",
      validationPassed: true,
      openStatus: "pending",
    },
  };

  assert.deepEqual(
    getPrDeliveryRetryEligibility({
      state: "failed",
      failureReason: "pr_open_failed",
      result,
    }),
    { canRetry: false, reason: "agent run has no reusable patch" },
  );
});

test("pr delivery retry is denied for non PR-open failures", () => {
  assert.deepEqual(
    getPrDeliveryRetryEligibility({
      state: "failed",
      failureReason: "runtime_budget_exhausted",
      result: null,
    }),
    { canRetry: false, reason: "agent run did not fail while opening a PR" },
  );
});
