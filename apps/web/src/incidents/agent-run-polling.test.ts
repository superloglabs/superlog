import assert from "node:assert/strict";
import test from "node:test";
import { INCIDENT_POLL_INTERVAL_MS, incidentPollIntervalMs } from "./agent-run-polling.ts";

// Poll only while the latest agent run is still doing (or about to do) work.
// The worker flushes new transcript events to Postgres every few seconds while
// a run is in an active state; once the run reaches a terminal state no more
// events will ever appear, so polling must stop.

test("polls while the run is running", () => {
  assert.equal(incidentPollIntervalMs("running"), INCIDENT_POLL_INTERVAL_MS);
});

test("polls in the pre-work active states (queued, repo_discovery, resuming, pr_retry_queued)", () => {
  for (const state of ["queued", "repo_discovery", "resuming", "pr_retry_queued"]) {
    assert.equal(
      incidentPollIntervalMs(state),
      INCIDENT_POLL_INTERVAL_MS,
      `expected to poll while ${state}`,
    );
  }
});

test("keeps polling while awaiting a human — a Slack reply elsewhere can resume the run", () => {
  assert.equal(incidentPollIntervalMs("awaiting_human"), INCIDENT_POLL_INTERVAL_MS);
});

test("stops polling in terminal states", () => {
  assert.equal(incidentPollIntervalMs("complete"), false);
  assert.equal(incidentPollIntervalMs("failed"), false);
});

test("stops polling for a dormant run that won't progress without an external webhook", () => {
  assert.equal(incidentPollIntervalMs("blocked_no_github"), false);
});

test("does not poll when there is no run yet", () => {
  assert.equal(incidentPollIntervalMs(undefined), false);
  assert.equal(incidentPollIntervalMs(null), false);
});

test("does not poll on an unknown/unexpected state (fail closed)", () => {
  assert.equal(incidentPollIntervalMs("something_new"), false);
});
