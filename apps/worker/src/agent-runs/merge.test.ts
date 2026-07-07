import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import { isMergeableIncidentPair } from "./merge.js";

function statusOnly(status: schema.IncidentStatus): Pick<schema.Incident, "status"> {
  return { status };
}

test("isMergeableIncidentPair allows an open source folding into an open target", () => {
  assert.equal(isMergeableIncidentPair(statusOnly("open"), statusOnly("open")), true);
});

test("isMergeableIncidentPair rejects a resolved merge target", () => {
  // loadMergeCandidates deliberately offers resolved incidents to the merge
  // judge as context, but mergeIncidentsInTx only supports open→open. Folding
  // into a resolved survivor must be declined here so the run completes
  // standalone rather than throwing IllegalIncidentTransitionError, which the
  // sync loop turns into a permanent `sync_failed`.
  assert.equal(isMergeableIncidentPair(statusOnly("open"), statusOnly("resolved")), false);
});

test("isMergeableIncidentPair rejects a source that was closed while the run was in flight", () => {
  for (const closed of ["resolved", "autoresolved_noise", "merged"] as const) {
    assert.equal(isMergeableIncidentPair(statusOnly(closed), statusOnly("open")), false, closed);
    assert.equal(isMergeableIncidentPair(statusOnly("open"), statusOnly(closed)), false, closed);
  }
});
