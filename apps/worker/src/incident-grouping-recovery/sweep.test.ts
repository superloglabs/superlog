import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  ISSUE_GROUPING_RETRY_DELAY_MS,
  type IssueGroupingRecoverySweepDeps,
  runIssueGroupingRecoverySweep,
} from "./sweep.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function issue(id: string): schema.Issue {
  return { id } as schema.Issue;
}

test("retries stale ungrouped issues and isolates one failed retry from the rest", async () => {
  const calls: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const deps: IssueGroupingRecoverySweepDeps = {
    now: () => NOW,
    async listCandidates(cutoff) {
      calls.push(`list:${cutoff.toISOString()}`);
      return [issue("first"), issue("second")];
    },
    async retry(candidate) {
      calls.push(`retry:${candidate.id}`);
      if (candidate.id === "first") throw new Error("grouping unavailable");
    },
    logger: {
      error(context) {
        errors.push(context);
      },
    },
  };

  const retried = await runIssueGroupingRecoverySweep(deps);

  assert.equal(retried, 1);
  assert.deepEqual(calls, [
    `list:${new Date(NOW.getTime() - ISSUE_GROUPING_RETRY_DELAY_MS).toISOString()}`,
    "retry:first",
    "retry:second",
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.issue_id, "first");
});
