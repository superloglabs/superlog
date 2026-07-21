import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { buildHomeIncidentTrend, summarizeAgentPullRequestStates } = await import(
  "./home-summary.js"
);

test("the home incident trend preserves uncapped aggregate counts", () => {
  const trend = buildHomeIncidentTrend(
    204,
    [
      { day: "2026-07-20", severity: "SEV-1", count: 3 },
      { day: "2026-07-20", severity: "SEV-2", count: "225" },
      { day: "2026-07-21", severity: null, count: 7 },
    ],
    new Date("2026-07-21T12:00:00.000Z"),
  );

  assert.equal(trend.active, 204);
  assert.equal(trend.rows.length, 7);
  assert.deepEqual(trend.rows.at(-2), {
    day: "2026-07-20",
    label: "Mon",
    sev1: 3,
    sev2: 225,
    sev3: 0,
    untriaged: 0,
  });
  assert.equal(trend.rows.at(-1)?.untriaged, 7);
});

test("the home pull request summary groups every non-merged PR without losing its lifecycle state", () => {
  const summary = summarizeAgentPullRequestStates([
    { state: "merged", count: 18 },
    { state: "open", count: 4 },
    { state: "closed", count: 2 },
  ]);

  assert.deepEqual(summary, {
    window: "30d",
    total: 24,
    merged: 18,
    unmerged: 6,
    open: 4,
    closed: 2,
  });
});
