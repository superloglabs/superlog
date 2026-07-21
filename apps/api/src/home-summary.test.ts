import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { summarizeAgentPullRequestStates } = await import("./home-summary.js");

test("the home pull request summary groups every non-merged PR without losing its lifecycle state", () => {
  const summary = summarizeAgentPullRequestStates([
    { state: "merged", count: 18 },
    { state: "open", count: 4 },
    { state: "closed", count: 2 },
  ]);

  assert.deepEqual(summary, {
    window: "30d",
    total: 24,
    merged: 18,
    unmerged: 6,
    open: 4,
    closed: 2,
  });
});
