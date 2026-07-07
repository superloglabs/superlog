import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOUDFLARE_PREFLIGHT_DETAIL,
  buildReferenceActivity,
  referenceIncidentStats,
} from "./incident-detail-reference-model.ts";

test("reference incident detail is pinned to the requested production incident", () => {
  assert.equal(CLOUDFLARE_PREFLIGHT_DETAIL.incident.id, "285160df-0e1c-4119-a481-4a54f2e5e72c");
  assert.equal(
    CLOUDFLARE_PREFLIGHT_DETAIL.incident.title,
    "Cloudflare integration setup fails — preflight check rejects OTLP intake",
  );
  assert.equal(CLOUDFLARE_PREFLIGHT_DETAIL.incident.codename, "opal-tanuki");
});

test("reference activity tells the preflight failure and fix story", () => {
  const activity = buildReferenceActivity(CLOUDFLARE_PREFLIGHT_DETAIL);

  assert.deepEqual(
    activity.map((item) => item.kind),
    ["detected", "status", "finding", "fact", "assignment", "priority", "fix"],
  );
  assert.match(activity[2]!.body, /skipPreflightCheck/);
  assert.match(activity[6]!.body, /raw Cloudflare error array/);
});

test("reference stats summarize duration and linked findings", () => {
  const stats = referenceIncidentStats(CLOUDFLARE_PREFLIGHT_DETAIL);

  assert.equal(stats.issueCountLabel, "1 finding");
  assert.equal(stats.durationLabel, "22 min 29 s");
  assert.equal(stats.latestDetectionLabel, "16:39 UTC");
});
