import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobDeps } from "../jobs.js";
import { createAutorecoveryJob } from "./autorecovery.js";

test("autorecovery runs from the background-job queue when configured", async () => {
  let runs = 0;
  let jobSignal: AbortSignal | undefined;
  const definition = createAutorecoveryJob({
    apiKey: "configured",
    run: async (signal) => {
      runs += 1;
      jobSignal = signal;
      return 0;
    },
  });

  assert.equal(definition.name, "autorecovery");
  assert.equal(definition.schedule, "*/5 * * * *");
  assert.equal(definition.expireInSeconds, 3_600);
  const handler = await definition.create({} as JobDeps);
  assert.ok(handler);

  await handler();
  assert.equal(runs, 1);
  assert.ok(jobSignal);
});
