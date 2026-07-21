import assert from "node:assert/strict";
import { test } from "node:test";
import { QUIET_INCIDENT_PERIOD_MS, type QuietIncidentCandidate } from "./domain.js";
import { type QuietIncidentResolutionSweepDeps, runQuietIncidentResolutionSweep } from "./sweep.js";

const NOW = new Date("2026-07-21T03:00:00.000Z");

function candidate(incidentId: string, lastSeen: Date): QuietIncidentCandidate {
  return { incidentId, linkedIssues: [{ id: `issue-${incidentId}`, lastSeen }] };
}

test("the daily sweep resolves eligible incidents and posts their Slack notification", async () => {
  const calls: string[] = [];
  const quietSince = new Date(NOW.getTime() - QUIET_INCIDENT_PERIOD_MS);
  const deps: QuietIncidentResolutionSweepDeps = {
    now: () => NOW,
    async listCandidates(cutoff) {
      calls.push(`list:${cutoff.toISOString()}`);
      return [
        candidate("quiet", quietSince),
        candidate("recent", new Date("2026-07-20T03:00:00.000Z")),
      ];
    },
    async resolveIfStillQuiet(input) {
      calls.push(`resolve:${input.incidentId}:${input.cutoff.toISOString()}`);
      return {
        kind: "resolved",
        linkedIssueCount: 1,
        quietSince,
      };
    },
    async postSlackNotification(input) {
      calls.push(`slack:${input.incidentId}:${input.message}`);
    },
    logger: { error() {} },
  };

  const resolved = await runQuietIncidentResolutionSweep(deps);

  assert.equal(resolved, 1);
  assert.deepEqual(calls, [
    "list:2026-07-07T03:00:00.000Z",
    "resolve:quiet:2026-07-07T03:00:00.000Z",
    "slack:quiet::white_check_mark: Automatically resolved after 14 days without recurrence. Latest activity across the linked error was <!date^1783393200^{date_short_pretty} at {time}|2026-07-07 03:00 UTC>.",
  ]);
});
