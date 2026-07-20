import assert from "node:assert/strict";
import { test } from "node:test";
import { isInvestigationInProgress } from "./investigation-progress.ts";

test("only agent states doing investigation work show progress", () => {
  for (const state of ["queued", "repo_discovery", "running", "resuming"]) {
    assert.equal(isInvestigationInProgress(state), true, `${state} should show progress`);
  }

  for (const state of [
    null,
    "awaiting_human",
    "awaiting_events",
    "pr_retry_queued",
    "blocked_no_github",
    "complete",
    "failed",
  ]) {
    assert.equal(isInvestigationInProgress(state), false, `${state} should not show progress`);
  }
});
