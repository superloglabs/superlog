import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveLifecycle } from "./loops-lifecycle.js";

// deriveLifecycle turns the raw per-signal timestamps (null = not happened,
// set = happened at that time) into the boolean + timestamp pairs Loops stores
// as contact properties. These are the properties the founder-nudge workflows
// trigger on, so the started-vs-merged distinction has to be exact.
const NONE = {
  telemetrySetAt: null,
  githubAddedAt: null,
  slackAddedAt: null,
  mcpInstalledAt: null,
  fixStartedAt: null,
  fixMergedAt: null,
} as const;

test("deriveLifecycle: a null fix timestamp is not-started, not-merged", () => {
  const life = deriveLifecycle({ ...NONE });
  assert.equal(life.fixStarted, false);
  assert.equal(life.fixStartedAt, null);
  assert.equal(life.fixMerged, false);
  assert.equal(life.fixMergedAt, null);
});

test("deriveLifecycle: a fix opened but not merged is started, not merged", () => {
  const life = deriveLifecycle({
    ...NONE,
    githubAddedAt: "2026-01-01T00:00:00.000Z",
    fixStartedAt: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(life.githubAdded, true);
  assert.equal(life.fixStarted, true);
  assert.equal(life.fixStartedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(life.fixMerged, false);
  assert.equal(life.fixMergedAt, null);
});

test("deriveLifecycle: a merged fix is both started and merged", () => {
  const life = deriveLifecycle({
    ...NONE,
    fixStartedAt: "2026-02-01T00:00:00.000Z",
    fixMergedAt: "2026-02-03T00:00:00.000Z",
  });
  assert.equal(life.fixStarted, true);
  assert.equal(life.fixMerged, true);
  assert.equal(life.fixMergedAt, "2026-02-03T00:00:00.000Z");
});

test("deriveLifecycle: every signal maps its timestamp to a boolean pair", () => {
  const life = deriveLifecycle({
    telemetrySetAt: "2026-01-01T00:00:00.000Z",
    githubAddedAt: "2026-01-02T00:00:00.000Z",
    slackAddedAt: null,
    mcpInstalledAt: "2026-01-04T00:00:00.000Z",
    fixStartedAt: "2026-01-05T00:00:00.000Z",
    fixMergedAt: "2026-01-06T00:00:00.000Z",
  });
  assert.deepEqual(life, {
    telemetrySet: true,
    telemetrySetAt: "2026-01-01T00:00:00.000Z",
    githubAdded: true,
    githubAddedAt: "2026-01-02T00:00:00.000Z",
    slackAdded: false,
    slackAddedAt: null,
    mcpInstalled: true,
    mcpInstalledAt: "2026-01-04T00:00:00.000Z",
    fixStarted: true,
    fixStartedAt: "2026-01-05T00:00:00.000Z",
    fixMerged: true,
    fixMergedAt: "2026-01-06T00:00:00.000Z",
  });
});
