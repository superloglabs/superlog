import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobDeps } from "../jobs.js";
import { createAutorecoveryJob } from "./autorecovery.js";

test("autorecovery runs from the background-job queue when configured", async () => {
  let runs = 0;
  const definition = createAutorecoveryJob({
    apiKey: "configured",
    run: async () => {
      runs += 1;
      return 0;
    },
  });

  assert.equal(definition.name, "autorecovery");
  assert.equal(definition.schedule, "*/5 * * * *");
  const handler = await definition.create({} as JobDeps);
  assert.ok(handler);

  await handler();
  assert.equal(runs, 1);
});
