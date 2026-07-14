import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveIncidentOrgBestEffort } from "./deliverable-records.js";

test("resolveIncidentOrgBestEffort preserves ticket completion when org lookup fails", async () => {
  const org = await resolveIncidentOrgBestEffort(async () => {
    throw new Error("database temporarily unavailable");
  });

  assert.equal(org, null);
});
