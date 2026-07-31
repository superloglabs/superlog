import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobDeps } from "../jobs.js";
import { createIncidentGroupingRecoveryJob } from "./incident-grouping-recovery.js";

test("records the number of issues recovered by each sweep", async () => {
  const recorded: number[] = [];
  const job = createIncidentGroupingRecoveryJob({
    async run() {
      return 3;
    },
    recordRecovered(count) {
      recorded.push(count);
    },
  });
  const handler = await job.create({} as JobDeps);
  assert.ok(handler);

  await handler();

  assert.deepEqual(recorded, [3]);
});
