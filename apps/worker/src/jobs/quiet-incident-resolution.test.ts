import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobDeps } from "../jobs.js";
import { createQuietIncidentResolutionJob } from "./quiet-incident-resolution.js";

test("quiet incident resolution runs once per day on its own background queue", async () => {
  let runs = 0;
  const definition = createQuietIncidentResolutionJob({
    run: async () => {
      runs += 1;
      return 0;
    },
  });

  assert.equal(definition.name, "quiet-incident-resolution");
  assert.equal(definition.schedule, "0 3 * * *");
  const handler = await definition.create({} as JobDeps);
  assert.ok(handler);

  await handler();
  assert.equal(runs, 1);
});
