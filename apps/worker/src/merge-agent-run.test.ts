import assert from "node:assert/strict";
import { test } from "node:test";
import { type MergeCandidateIncident, buildUserMessage } from "./merge-agent-run.js";

const representative = {
  exceptionType: "RuntimeError",
  message: "Failed to get NET32 session: Invalid username or password",
  topFrame: "worker.py:1362",
  normalizedFrames: ["worker.py:1362"],
};

const candidate: MergeCandidateIncident = {
  id: "incident-canonical",
  title: "DentalCity order history retries indefinitely on invalid credentials",
  service: "websites-api-worker",
  firstSeen: "2026-06-11T00:00:00.000Z",
  lastSeen: "2026-06-14T00:00:00.000Z",
  issueCount: 12,
  proposedTitle: null,
  summary: "Order history SQS message is never deleted on invalid credentials.",
  fixTargets: ["worker.py"],
  priorPrState: "closed",
  representative,
};

test("buildUserMessage surfaces fix targets so the judge can match same-file fixes", () => {
  const message = buildUserMessage({
    projectName: "Alara",
    source: {
      title: "NET32 order history retries indefinitely",
      service: "websites-api-worker",
      firstSeen: "2026-06-12T00:00:00.000Z",
      lastSeen: "2026-06-14T00:00:00.000Z",
      issueCount: 9,
      proposedTitle: null,
      summary: "Invalid-credential SQS messages retry forever; delete them instead.",
      fixTargets: ["worker.py"],
      priorPrState: null,
      representative,
    },
    candidates: [candidate],
  });

  // Both incidents' fix touches worker.py — the message must carry that signal.
  assert.match(message, /fixTargets/);
  assert.match(message, /worker\.py/);
  // A closed prior PR is still surfaced (not dropped).
  assert.match(message, /"priorPrState": "closed"/);
});
