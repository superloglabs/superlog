import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReopenedIncidentSlackUpdate } from "./incident-slack.js";

test("reopened incident with queued investigation includes the queue ping", () => {
  const update = buildReopenedIncidentSlackUpdate({
    issueTitle: "Checkout API timeout",
    queueStatus: "queued",
  });

  assert.equal(
    update.threadSummary,
    ":rotating_light: Incident reopened because linked issue regressed: *Checkout API timeout*\n:mag: Investigation queued.",
  );
  assert.equal(update.rootStatus, "Incident reopened · investigation queued");
  assert.equal(update.rootTagline, "Linked issue regressed: Checkout API timeout");
});

test("reopened incident with suppressed investigation still emits a reopen ping", () => {
  const update = buildReopenedIncidentSlackUpdate({
    issueTitle: "Checkout API timeout",
    queueStatus: "suppressed",
  });

  assert.match(update.threadSummary, /Incident reopened because linked issue regressed/);
  assert.match(update.threadSummary, /Auto-investigation is temporarily suppressed/);
  assert.equal(update.rootStatus, "Incident reopened");
  assert.equal(update.rootTagline, "Linked issue regressed: Checkout API timeout");
});
