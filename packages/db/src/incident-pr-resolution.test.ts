import assert from "node:assert/strict";
import { test } from "node:test";
import { type DB } from "./client.js";
import {
  closeIncidentOpenPullRequestsAfterResolution,
  type IncidentOpenPullRequestToClose,
} from "./incident-pr-resolution.js";
import * as schema from "./schema.js";

type RecordedCall =
  | { op: "update"; table: unknown; values: Record<string, unknown> }
  | { op: "insert"; table: unknown; values: Record<string, unknown> };

function recordingDb(rows: IncidentOpenPullRequestToClose[]): { db: DB; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                async where() {
                  return rows;
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where() {
              calls.push({ op: "update", table, values });
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return {
            async onConflictDoNothing() {
              calls.push({ op: "insert", table, values });
            },
          };
        },
      };
    },
  } as unknown as DB;
  return { db, calls };
}

test("closeIncidentOpenPullRequestsAfterResolution closes open PRs and records events", async () => {
  const closedAt = new Date("2026-06-07T01:02:03.000Z");
  const { db, calls } = recordingDb([
    { id: "pr-1", githubInstallationId: 101, repoFullName: "acme/api", prNumber: 12 },
    { id: "pr-2", githubInstallationId: 202, repoFullName: "acme/web", prNumber: 34 },
  ]);
  const closed: string[] = [];

  const result = await closeIncidentOpenPullRequestsAfterResolution({
    incidentId: "inc-1",
    database: db,
    now: () => closedAt,
    closePullRequest: async (pr) => {
      closed.push(`${pr.repoFullName}#${pr.prNumber}`);
      return { ok: true };
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 2, failedPullRequestCount: 0 });
  assert.deepEqual(closed, ["acme/api#12", "acme/web#34"]);
  const updates = calls.filter((call) => call.op === "update");
  assert.equal(updates.length, 2);
  assert.equal(updates[0]?.table, schema.agentPullRequests);
  assert.equal(updates[0]?.values.state, "closed");
  assert.equal(updates[0]?.values.closedAt, closedAt);
  const events = calls.filter((call) => call.op === "insert");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.table, schema.agentPrEvents);
  assert.equal(events[0]?.values.kind, "pr_closed");
});

test("closeIncidentOpenPullRequestsAfterResolution leaves failed PRs open", async () => {
  const { db, calls } = recordingDb([
    { id: "pr-1", githubInstallationId: 101, repoFullName: "acme/api", prNumber: 12 },
  ]);
  const failures: string[] = [];

  const result = await closeIncidentOpenPullRequestsAfterResolution({
    incidentId: "inc-1",
    database: db,
    closePullRequest: async () => ({ ok: false, error: "rate_limited" }),
    onCloseFailure: ({ pr, error }) => failures.push(`${pr.id}:${error}`),
  });

  assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 1 });
  assert.deepEqual(failures, ["pr-1:rate_limited"]);
  assert.equal(calls.length, 0);
});
