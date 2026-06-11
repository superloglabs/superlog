import assert from "node:assert/strict";
import { test } from "node:test";
import type { DB } from "./client.js";
import {
  type IncidentOpenPullRequestToClose,
  closeIncidentOpenPullRequestsAfterResolution,
} from "./incident-pr-resolution.js";
import * as schema from "./schema.js";

type RecordedCall =
  | { op: "update"; table: unknown; values: Record<string, unknown> }
  | { op: "insert"; table: unknown; values: Record<string, unknown> };

type OpenPullRequestTestRow = IncidentOpenPullRequestToClose & { projectId?: string | null };

function recordingDb(opts: {
  openPullRequests: OpenPullRequestTestRow[];
  projectInstallationIds?: Array<{ projectId: string; githubInstallationId: number }>;
  projectRepoInstallationIds?: Array<{ projectId: string; githubInstallationId: number }>;
}): { db: DB; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const selectRows = [
    opts.openPullRequests,
    opts.projectInstallationIds ?? [],
    opts.projectRepoInstallationIds ?? [],
  ];
  const db = {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                async where() {
                  return selectRows.shift() ?? [];
                },
                innerJoin() {
                  return {
                    async where() {
                      return selectRows.shift() ?? [];
                    },
                  };
                },
              };
            },
            async where() {
              return selectRows.shift() ?? [];
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
  const { db, calls } = recordingDb({
    openPullRequests: [
      {
        id: "pr-1",
        githubInstallationId: 101,
        fallbackGithubInstallationIds: [],
        repoFullName: "acme/api",
        prNumber: 12,
        prNodeId: "PR_node_1",
      },
      {
        id: "pr-2",
        githubInstallationId: 202,
        fallbackGithubInstallationIds: [],
        repoFullName: "acme/web",
        prNumber: 34,
        prNodeId: null,
      },
    ],
  });
  const closed: string[] = [];

  const result = await closeIncidentOpenPullRequestsAfterResolution({
    incidentId: "inc-1",
    database: db,
    now: () => closedAt,
    closePullRequest: async (pr) => {
      closed.push(`${pr.repoFullName}#${pr.prNumber}:${pr.prNodeId ?? "no-node"}`);
      return { ok: true };
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 2, failedPullRequestCount: 0 });
  assert.deepEqual(closed, ["acme/api#12:PR_node_1", "acme/web#34:no-node"]);
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
  const { db, calls } = recordingDb({
    openPullRequests: [
      {
        id: "pr-1",
        githubInstallationId: 101,
        fallbackGithubInstallationIds: [],
        repoFullName: "acme/api",
        prNumber: 12,
        prNodeId: "PR_node_1",
      },
    ],
  });
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

test("closeIncidentOpenPullRequestsAfterResolution offers current project installations as fallback", async () => {
  const { db } = recordingDb({
    openPullRequests: [
      {
        id: "pr-1",
        projectId: "project-1",
        githubInstallationId: 101,
        fallbackGithubInstallationIds: [],
        repoFullName: "old-owner/api",
        prNumber: 12,
        prNodeId: "PR_node_1",
      },
    ],
    projectInstallationIds: [
      { projectId: "project-1", githubInstallationId: 303 },
      { projectId: "project-1", githubInstallationId: 101 },
    ],
    projectRepoInstallationIds: [{ projectId: "project-1", githubInstallationId: 404 }],
  });
  const attempted: number[][] = [];

  await closeIncidentOpenPullRequestsAfterResolution({
    incidentId: "inc-1",
    database: db,
    closePullRequest: async (pr) => {
      attempted.push([pr.githubInstallationId, ...pr.fallbackGithubInstallationIds]);
      return { ok: true };
    },
  });

  assert.deepEqual(attempted, [[101, 303, 404]]);
});
