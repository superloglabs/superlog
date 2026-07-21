import assert from "node:assert/strict";
import { test } from "node:test";
import { QUIET_INCIDENT_PERIOD_MS, decideQuietIncidentResolution } from "./domain.js";

const NOW = new Date("2026-07-21T03:00:00.000Z");

test("an incident becomes eligible when every linked issue has been quiet for 14 days", () => {
  const decision = decideQuietIncidentResolution(
    {
      incidentId: "incident-1",
      linkedIssues: [
        { id: "issue-1", lastSeen: new Date(NOW.getTime() - QUIET_INCIDENT_PERIOD_MS) },
        { id: "issue-2", lastSeen: new Date("2026-06-01T00:00:00.000Z") },
      ],
    },
    NOW,
  );

  assert.deepEqual(decision, {
    kind: "resolve",
    quietSince: new Date("2026-07-07T03:00:00.000Z"),
    linkedIssueCount: 2,
  });
});

test("one recent linked issue keeps the incident open", () => {
  const decision = decideQuietIncidentResolution(
    {
      incidentId: "incident-1",
      linkedIssues: [
        { id: "issue-old", lastSeen: new Date("2026-06-01T00:00:00.000Z") },
        { id: "issue-recent", lastSeen: new Date("2026-07-08T03:00:00.000Z") },
      ],
    },
    NOW,
  );

  assert.deepEqual(decision, { kind: "keep_open", reason: "recent_recurrence" });
});

test("an incident without linked issues stays open", () => {
  assert.deepEqual(
    decideQuietIncidentResolution({ incidentId: "incident-1", linkedIssues: [] }, NOW),
    { kind: "keep_open", reason: "no_linked_issues" },
  );
});

test("Slack copy explains the automatic resolution and localizes the last recurrence time", async () => {
  const { buildQuietIncidentResolvedSlackMessage } = await import("./slack-message.js");

  assert.equal(
    buildQuietIncidentResolvedSlackMessage({
      linkedIssueCount: 2,
      quietSince: new Date("2026-07-07T03:00:00.000Z"),
    }),
    ":white_check_mark: Automatically resolved after 14 days without recurrence. Latest activity across 2 linked errors was <!date^1783393200^{date_short_pretty} at {time}|2026-07-07 03:00 UTC>.",
  );
});
