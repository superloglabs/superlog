import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { applyAgentPullRequestState } from "./agent-pr-state.js";
import type { DB } from "./client.js";
import {
  type IncidentOpenPullRequestToClose,
  closeIncidentOpenPullRequestsAfterResolution,
} from "./incident-pr-resolution.js";
import * as schema from "./schema.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { createIncidentLifecycle } = await import("./resolve-incident.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, "expected one row");
  return row;
}

async function freshDb(): Promise<{ db: DB; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

async function seedResolutionScenario(db: DB) {
  const org = one(
    await db
      .insert(schema.orgs)
      .values({ name: "Resolution org", slug: "resolution-org" })
      .returning(),
  );
  const project = one(
    await db
      .insert(schema.projects)
      .values({ orgId: org.id, name: "Resolution project", slug: "resolution-project" })
      .returning(),
  );
  const installation = one(
    await db
      .insert(schema.githubInstallations)
      .values({
        orgId: org.id,
        projectId: project.id,
        installationId: 101,
        accountLogin: "acme",
        accountType: "Organization",
      })
      .returning(),
  );
  const incident = one(
    await db
      .insert(schema.incidents)
      .values({
        projectId: project.id,
        title: "Resolution race",
        codename: "resolution-race",
        status: "open",
        firstSeen: new Date("2026-07-14T10:00:00.000Z"),
        lastSeen: new Date("2026-07-14T10:00:00.000Z"),
      })
      .returning(),
  );
  const agentRun = one(
    await db
      .insert(schema.agentRuns)
      .values({ incidentId: incident.id, runtime: "test", state: "running" })
      .returning(),
  );
  const pullRequest = one(
    await db
      .insert(schema.agentPullRequests)
      .values({
        incidentId: incident.id,
        agentRunId: agentRun.id,
        installationId: installation.id,
        repoFullName: "acme/api",
        prNumber: 42,
        url: "https://github.com/acme/api/pull/42",
        branchName: "fix/resolution-race",
        baseBranch: "main",
        state: "open",
      })
      .returning(),
  );
  return { incident, agentRun, pullRequest };
}

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
            where() {
              calls.push({ op: "update", table, values });
              return {
                async returning() {
                  return [{ id: "updated" }];
                },
              };
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
      return { ok: true, providerUpdatedAt: closedAt };
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

test("a late completion cannot close pull requests after its resolution epoch was reopened", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const resolvedAt = new Date("2026-07-14T11:00:00.000Z");
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-1`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "The remediation is complete.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt,
    });
    const resolvedIncident = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    await createIncidentLifecycle(db).reopenManually({
      incident: resolvedIncident,
      actor: { userId: null },
      reopenedAt: new Date("2026-07-14T11:05:00.000Z"),
    });

    let providerCloseCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      closePullRequest: async () => {
        providerCloseCount += 1;
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:01:00.000Z"),
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    assert.equal(providerCloseCount, 0);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "open");
  } finally {
    await client.close();
  }
});

test("the current resolution epoch closes and records its open pull requests", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-current`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Current resolution.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    let providerCloseCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      closePullRequest: async () => {
        providerCloseCount += 1;
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:04:30.000Z"),
        };
      },
      reopenPullRequest: async () => ({ ok: true }),
    });

    assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
    assert.equal(providerCloseCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "closed");
  } finally {
    await client.close();
  }
});

test("an old resolution proof stays stale after the reopened incident resolves again", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedResolutionScenario(db);
    const oldDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-old`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "First resolution.",
      agentRunId: agentRun.id,
      eventDedupeKey: oldDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });
    const firstResolution = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    await createIncidentLifecycle(db).reopenManually({
      incident: firstResolution,
      actor: { userId: null },
      reopenedAt: new Date("2026-07-14T11:05:00.000Z"),
    });
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: "Second resolution.",
      eventDedupeKey: `incident_resolved:dashboard:${incident.id}:second`,
      resolvedAt: new Date("2026-07-14T11:10:00.000Z"),
    });

    let providerCloseCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey: oldDedupeKey },
      database: db,
      closePullRequest: async () => {
        providerCloseCount += 1;
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:07:00.000Z"),
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    assert.equal(providerCloseCount, 0);
  } finally {
    await client.close();
  }
});

test("a reopen committed during provider closure compensates the stale pull request mutation", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-race`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before the race.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    let providerCloseCount = 0;
    let providerReopenCount = 0;
    const clock = [new Date("2026-07-14T11:04:00.000Z"), new Date("2026-07-14T11:06:00.000Z")];
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => clock.shift() ?? new Date("2026-07-14T11:06:00.000Z"),
      closePullRequest: async () => {
        providerCloseCount += 1;
        const resolvedIncident = one(
          await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
        );
        await createIncidentLifecycle(db).reopenManually({
          incident: resolvedIncident,
          actor: { userId: null },
          reopenedAt: new Date("2026-07-14T11:05:00.000Z"),
        });
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:04:30.000Z"),
        };
      },
      reopenPullRequest: async () => {
        providerReopenCount += 1;
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:05:30.000Z"),
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    assert.equal(providerCloseCount, 1);
    assert.equal(providerReopenCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "open");
    assert.equal(pullRequestAfter.lastSyncedAt?.toISOString(), "2026-07-14T11:06:00.000Z");
    assert.equal(pullRequestAfter.providerUpdatedAt?.toISOString(), "2026-07-14T11:05:30.000Z");

    const delayedClose = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date("2026-07-14T11:07:00.000Z"),
      providerUpdatedAt: new Date("2026-07-14T11:04:30.000Z"),
      closedAt: new Date("2026-07-14T11:04:00.000Z"),
    });
    assert.equal(delayedClose.pullRequest?.state, "open");
    assert.equal(delayedClose.stateChanged, false);
  } finally {
    await client.close();
  }
});

test("reopen compensation cannot regress a newer provider observation", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-provider-race`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before the provider race.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const newerProviderCloseAt = new Date("2026-07-14T11:06:00.000Z");
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => new Date("2026-07-14T11:07:00.000Z"),
      closePullRequest: async () => {
        const resolvedIncident = one(
          await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
        );
        await createIncidentLifecycle(db).reopenManually({
          incident: resolvedIncident,
          actor: { userId: null },
          reopenedAt: new Date("2026-07-14T11:04:00.000Z"),
        });
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:03:00.000Z"),
        };
      },
      reopenPullRequest: async () => {
        const newerClose = await applyAgentPullRequestState(db, {
          incidentId: incident.id,
          agentPrId: pullRequest.id,
          targetState: "closed",
          observedAt: new Date("2026-07-14T11:07:00.000Z"),
          providerUpdatedAt: newerProviderCloseAt,
          closedAt: newerProviderCloseAt,
        });
        assert.equal(newerClose.stateChanged, true);
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:05:00.000Z"),
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "closed");
    assert.equal(
      pullRequestAfter.providerUpdatedAt?.toISOString(),
      newerProviderCloseAt.toISOString(),
    );
    assert.equal(pullRequestAfter.closedAt?.toISOString(), newerProviderCloseAt.toISOString());
  } finally {
    await client.close();
  }
});

test("resolution finalization cannot regress a newer provider reopen", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-finalize-race`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before the finalization race.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const newerProviderReopenAt = new Date("2026-07-14T11:06:00.000Z");
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => new Date("2026-07-14T11:07:00.000Z"),
      closePullRequest: async () => {
        const newerReopen = await applyAgentPullRequestState(db, {
          incidentId: incident.id,
          agentPrId: pullRequest.id,
          targetState: "open",
          observedAt: new Date("2026-07-14T11:07:00.000Z"),
          providerUpdatedAt: newerProviderReopenAt,
          closedAt: null,
        });
        assert.equal(newerReopen.pullRequest?.state, "open");
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:05:00.000Z"),
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "open");
    assert.equal(
      pullRequestAfter.providerUpdatedAt?.toISOString(),
      newerProviderReopenAt.toISOString(),
    );
    assert.equal(pullRequestAfter.closedAt, null);
  } finally {
    await client.close();
  }
});

test("resolution finalization reads authoritative state after an equal-timestamp reopen arrives during closure", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-equal-finalize-race`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before the equal-time provider race.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const providerUpdatedAt = new Date("2026-07-14T11:04:30.000Z");
    let authoritativeReadCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => new Date("2026-07-14T11:04:00.000Z"),
      closePullRequest: async () => {
        const concurrentReopen = await applyAgentPullRequestState(db, {
          incidentId: incident.id,
          agentPrId: pullRequest.id,
          targetState: "open",
          observedAt: new Date("2026-07-14T11:05:00.000Z"),
          providerUpdatedAt,
          closedAt: null,
        });
        assert.equal(concurrentReopen.pullRequest?.state, "open");
        return {
          ok: true,
          providerUpdatedAt,
          async loadAuthoritativeObservation() {
            authoritativeReadCount += 1;
            return {
              targetState: "closed" as const,
              observedAt: new Date("2026-07-14T11:06:00.000Z"),
              providerUpdatedAt,
              closedAt: providerUpdatedAt,
            };
          },
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
    assert.equal(authoritativeReadCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "closed");
    assert.equal(
      pullRequestAfter.providerUpdatedAt?.toISOString(),
      providerUpdatedAt.toISOString(),
    );
  } finally {
    await client.close();
  }
});

test("resolution finalization compensates when the Incident reopens during the authoritative read", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-authoritative-reopen-race`;
    const lifecycle = createIncidentLifecycle(db);
    await lifecycle.resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before the authoritative-read reopen race.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const providerUpdatedAt = new Date("2026-07-14T11:04:30.000Z");
    let providerReopenCount = 0;
    let authoritativeReadCount = 0;
    let compensationReadCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => new Date("2026-07-14T11:04:00.000Z"),
      closePullRequest: async () => {
        await applyAgentPullRequestState(db, {
          incidentId: incident.id,
          agentPrId: pullRequest.id,
          targetState: "open",
          observedAt: new Date("2026-07-14T11:05:00.000Z"),
          providerUpdatedAt,
          closedAt: null,
        });
        return {
          ok: true,
          providerUpdatedAt,
          async loadAuthoritativeObservation() {
            authoritativeReadCount += 1;
            const resolvedIncident = one(
              await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
            );
            await lifecycle.reopenManually({
              incident: resolvedIncident,
              actor: { userId: null },
              reopenedAt: new Date("2026-07-14T11:05:30.000Z"),
            });
            return {
              targetState: "closed" as const,
              observedAt: new Date("2026-07-14T11:06:00.000Z"),
              providerUpdatedAt,
              closedAt: providerUpdatedAt,
            };
          },
        };
      },
      reopenPullRequest: async () => {
        providerReopenCount += 1;
        return {
          ok: true,
          async loadAuthoritativeObservation() {
            compensationReadCount += 1;
            return {
              targetState: "open" as const,
              observedAt: new Date("2026-07-14T11:07:30.000Z"),
              providerUpdatedAt: new Date("2026-07-14T11:07:00.000Z"),
              closedAt: null,
            };
          },
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    assert.equal(authoritativeReadCount, 1);
    assert.equal(compensationReadCount, 1);
    assert.equal(providerReopenCount, 1);
    const incidentAfter = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(incidentAfter.status, "open");
    assert.equal(pullRequestAfter.state, "open");
    assert.equal(pullRequestAfter.closedAt, null);
    const delayedClose = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date("2026-07-14T11:08:00.000Z"),
      providerUpdatedAt: new Date("2026-07-14T11:06:30.000Z"),
      closedAt: new Date("2026-07-14T11:06:30.000Z"),
    });
    assert.equal(delayedClose.pullRequest?.state, "open");
  } finally {
    await client.close();
  }
});

test("closure without a resolution proof still reads authoritative state for an equal-timestamp race", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedResolutionScenario(db);
    const providerUpdatedAt = new Date("2026-07-14T11:04:30.000Z");
    let authoritativeReadCount = 0;

    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      database: db,
      now: () => new Date("2026-07-14T11:04:00.000Z"),
      closePullRequest: async () => {
        await applyAgentPullRequestState(db, {
          incidentId: incident.id,
          agentPrId: pullRequest.id,
          targetState: "open",
          observedAt: new Date("2026-07-14T11:05:00.000Z"),
          providerUpdatedAt,
          closedAt: null,
        });
        return {
          ok: true,
          providerUpdatedAt,
          async loadAuthoritativeObservation() {
            authoritativeReadCount += 1;
            return {
              targetState: "closed" as const,
              observedAt: new Date("2026-07-14T11:06:00.000Z"),
              providerUpdatedAt,
              closedAt: providerUpdatedAt,
            };
          },
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
    assert.equal(authoritativeReadCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "closed");
  } finally {
    await client.close();
  }
});

test("resolution finalization reads authoritative state when a successful close has no provider watermark", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-unwatermarked-close`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before an unwatermarked provider close.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const priorProviderUpdatedAt = new Date("2026-07-14T11:03:00.000Z");
    await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: priorProviderUpdatedAt,
      providerUpdatedAt: priorProviderUpdatedAt,
      providerSnapshotAuthoritative: true,
      closedAt: null,
    });

    let authoritativeReadCount = 0;
    const authoritativeProviderUpdatedAt = new Date("2026-07-14T11:05:00.000Z");
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => new Date("2026-07-14T11:04:00.000Z"),
      closePullRequest: async () => ({
        ok: true,
        async loadAuthoritativeObservation() {
          authoritativeReadCount += 1;
          return {
            targetState: "closed" as const,
            observedAt: new Date("2026-07-14T11:06:00.000Z"),
            providerUpdatedAt: authoritativeProviderUpdatedAt,
            closedAt: authoritativeProviderUpdatedAt,
          };
        },
      }),
    });

    assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
    assert.equal(authoritativeReadCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "closed");
    assert.equal(
      pullRequestAfter.providerUpdatedAt?.toISOString(),
      authoritativeProviderUpdatedAt.toISOString(),
    );
  } finally {
    await client.close();
  }
});

test("resolution finalization reads authority for an equal observation despite local clock ordering", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-equal-prior-observation`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution after an equal-time provider observation.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const providerUpdatedAt = new Date("2026-07-14T11:03:30.000Z");
    await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: new Date("2026-07-14T11:03:00.000Z"),
      providerUpdatedAt,
      providerSnapshotAuthoritative: true,
      closedAt: null,
    });

    let authoritativeReadCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => new Date("2026-07-14T11:04:00.000Z"),
      closePullRequest: async () => ({
        ok: true,
        providerUpdatedAt,
        async loadAuthoritativeObservation() {
          authoritativeReadCount += 1;
          return {
            targetState: "closed" as const,
            observedAt: new Date("2026-07-14T11:05:00.000Z"),
            providerUpdatedAt,
            closedAt: providerUpdatedAt,
          };
        },
      }),
    });

    assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
    assert.equal(authoritativeReadCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "closed");
  } finally {
    await client.close();
  }
});

test("reopen compensation reads authoritative state after an equal-timestamp close arrives during reopening", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-equal-compensation-race`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before the equal-time compensation race.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const providerUpdatedAt = new Date("2026-07-14T11:05:30.000Z");
    const clock = [
      new Date("2026-07-14T11:04:00.000Z"),
      new Date("2026-07-14T11:05:00.000Z"),
      new Date("2026-07-14T11:07:00.000Z"),
    ];
    let authoritativeReadCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => clock.shift() ?? new Date("2026-07-14T11:07:00.000Z"),
      closePullRequest: async () => {
        const resolvedIncident = one(
          await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
        );
        await createIncidentLifecycle(db).reopenManually({
          incident: resolvedIncident,
          actor: { userId: null },
          reopenedAt: new Date("2026-07-14T11:04:30.000Z"),
        });
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:04:15.000Z"),
        };
      },
      reopenPullRequest: async () => {
        const concurrentClose = await applyAgentPullRequestState(db, {
          incidentId: incident.id,
          agentPrId: pullRequest.id,
          targetState: "closed",
          observedAt: new Date("2026-07-14T11:06:00.000Z"),
          providerUpdatedAt,
          closedAt: providerUpdatedAt,
        });
        assert.equal(concurrentClose.pullRequest?.state, "closed");
        return {
          ok: true,
          providerUpdatedAt,
          async loadAuthoritativeObservation() {
            authoritativeReadCount += 1;
            return {
              targetState: "open" as const,
              observedAt: new Date("2026-07-14T11:07:00.000Z"),
              providerUpdatedAt,
              closedAt: null,
            };
          },
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    assert.equal(authoritativeReadCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "open");
    assert.equal(
      pullRequestAfter.providerUpdatedAt?.toISOString(),
      providerUpdatedAt.toISOString(),
    );
    assert.equal(pullRequestAfter.closedAt, null);
  } finally {
    await client.close();
  }
});

test("reopen compensation reads authoritative state when its successful response has no provider watermark", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const eventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-unwatermarked-reopen`;
    const lifecycle = createIncidentLifecycle(db);
    await lifecycle.resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before an unwatermarked provider reopen.",
      agentRunId: agentRun.id,
      eventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const concurrentProviderCloseAt = new Date("2026-07-14T11:06:00.000Z");
    const authoritativeProviderUpdatedAt = new Date("2026-07-14T11:06:30.000Z");
    const clock = [
      new Date("2026-07-14T11:04:00.000Z"),
      new Date("2026-07-14T11:05:00.000Z"),
      new Date("2026-07-14T11:07:00.000Z"),
    ];
    let authoritativeReadCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey },
      database: db,
      now: () => clock.shift() ?? new Date("2026-07-14T11:08:00.000Z"),
      closePullRequest: async () => {
        const resolvedIncident = one(
          await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
        );
        await lifecycle.reopenManually({
          incident: resolvedIncident,
          actor: { userId: null },
          reopenedAt: new Date("2026-07-14T11:04:30.000Z"),
        });
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:04:15.000Z"),
        };
      },
      reopenPullRequest: async () => {
        await applyAgentPullRequestState(db, {
          incidentId: incident.id,
          agentPrId: pullRequest.id,
          targetState: "closed",
          observedAt: concurrentProviderCloseAt,
          providerUpdatedAt: concurrentProviderCloseAt,
          closedAt: concurrentProviderCloseAt,
        });
        return {
          ok: true,
          async loadAuthoritativeObservation() {
            authoritativeReadCount += 1;
            return {
              targetState: "open" as const,
              observedAt: new Date("2026-07-14T11:07:30.000Z"),
              providerUpdatedAt: authoritativeProviderUpdatedAt,
              closedAt: null,
            };
          },
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    assert.equal(authoritativeReadCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "open");
    assert.equal(
      pullRequestAfter.providerUpdatedAt?.toISOString(),
      authoritativeProviderUpdatedAt.toISOString(),
    );
  } finally {
    await client.close();
  }
});

test("reopen compensation re-closes when a newer resolution wins during a clean provider reopen", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const oldEventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-clean-reopen-race`;
    const lifecycle = createIncidentLifecycle(db);
    await lifecycle.resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before the clean provider-reopen race.",
      agentRunId: agentRun.id,
      eventDedupeKey: oldEventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    let providerCloseCount = 0;
    let providerReopenCount = 0;
    const clock = [
      new Date("2026-07-14T11:04:00.000Z"),
      new Date("2026-07-14T11:05:00.000Z"),
      new Date("2026-07-14T11:07:30.000Z"),
    ];
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey: oldEventDedupeKey },
      database: db,
      now: () => clock.shift() ?? new Date("2026-07-14T11:08:00.000Z"),
      closePullRequest: async () => {
        providerCloseCount += 1;
        if (providerCloseCount === 1) {
          const resolvedIncident = one(
            await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
          );
          await lifecycle.reopenManually({
            incident: resolvedIncident,
            actor: { userId: null },
            reopenedAt: new Date("2026-07-14T11:04:30.000Z"),
          });
          return {
            ok: true,
            providerUpdatedAt: new Date("2026-07-14T11:04:15.000Z"),
          };
        }
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:08:00.000Z"),
        };
      },
      reopenPullRequest: async () => {
        providerReopenCount += 1;
        await lifecycle.resolve({
          incidentId: incident.id,
          kind: "dashboard_manual",
          reasonCode: "problem_resolved",
          reasonText: "A newer resolution won during the clean provider reopen.",
          eventDedupeKey: `incident_resolved:dashboard:${incident.id}:clean-reopen-newer`,
          resolvedAt: new Date("2026-07-14T11:06:00.000Z"),
        });
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:07:00.000Z"),
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
    assert.equal(providerCloseCount, 2);
    assert.equal(providerReopenCount, 1);
    const incidentAfter = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(incidentAfter.status, "resolved");
    assert.equal(pullRequestAfter.state, "closed");
  } finally {
    await client.close();
  }
});

test("reopen compensation re-closes when a newer resolution wins during the authoritative read", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const oldEventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-authoritative-resolve-race`;
    const lifecycle = createIncidentLifecycle(db);
    await lifecycle.resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "Resolution before the authoritative-read newer-resolution race.",
      agentRunId: agentRun.id,
      eventDedupeKey: oldEventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    const providerUpdatedAt = new Date("2026-07-14T11:05:30.000Z");
    let providerCloseCount = 0;
    let providerReopenCount = 0;
    let authoritativeReadCount = 0;
    let compensationReadCount = 0;
    const clock = [
      new Date("2026-07-14T11:04:00.000Z"),
      new Date("2026-07-14T11:05:00.000Z"),
      new Date("2026-07-14T11:07:00.000Z"),
      new Date("2026-07-14T11:08:00.000Z"),
    ];
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey: oldEventDedupeKey },
      database: db,
      now: () => clock.shift() ?? new Date("2026-07-14T11:08:00.000Z"),
      closePullRequest: async () => {
        providerCloseCount += 1;
        if (providerCloseCount === 1) {
          const resolvedIncident = one(
            await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
          );
          await lifecycle.reopenManually({
            incident: resolvedIncident,
            actor: { userId: null },
            reopenedAt: new Date("2026-07-14T11:04:30.000Z"),
          });
          return {
            ok: true,
            providerUpdatedAt: new Date("2026-07-14T11:04:15.000Z"),
          };
        }
        return {
          ok: true,
          async loadAuthoritativeObservation() {
            compensationReadCount += 1;
            return {
              targetState: "closed" as const,
              observedAt: new Date("2026-07-14T11:08:30.000Z"),
              providerUpdatedAt: new Date("2026-07-14T11:08:00.000Z"),
              closedAt: new Date("2026-07-14T11:08:00.000Z"),
            };
          },
        };
      },
      reopenPullRequest: async () => {
        providerReopenCount += 1;
        await applyAgentPullRequestState(db, {
          incidentId: incident.id,
          agentPrId: pullRequest.id,
          targetState: "closed",
          observedAt: new Date("2026-07-14T11:06:00.000Z"),
          providerUpdatedAt,
          closedAt: providerUpdatedAt,
        });
        return {
          ok: true,
          providerUpdatedAt,
          async loadAuthoritativeObservation() {
            authoritativeReadCount += 1;
            await lifecycle.resolve({
              incidentId: incident.id,
              kind: "dashboard_manual",
              reasonCode: "problem_resolved",
              reasonText: "A newer resolution won during provider reconciliation.",
              eventDedupeKey: `incident_resolved:dashboard:${incident.id}:authoritative-newer`,
              resolvedAt: new Date("2026-07-14T11:06:30.000Z"),
            });
            return {
              targetState: "open" as const,
              observedAt: new Date("2026-07-14T11:07:00.000Z"),
              providerUpdatedAt,
              closedAt: null,
            };
          },
        };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
    assert.equal(providerCloseCount, 2);
    assert.equal(providerReopenCount, 1);
    assert.equal(authoritativeReadCount, 1);
    assert.equal(compensationReadCount, 1);
    const incidentAfter = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(incidentAfter.status, "resolved");
    assert.equal(pullRequestAfter.state, "closed");
    const delayedReopen = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: new Date("2026-07-14T11:09:00.000Z"),
      providerUpdatedAt: new Date("2026-07-14T11:07:30.000Z"),
      closedAt: null,
    });
    assert.equal(delayedReopen.pullRequest?.state, "closed");
  } finally {
    await client.close();
  }
});

test("a newer resolution committed during stale provider closure keeps the pull request closed", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, pullRequest } = await seedResolutionScenario(db);
    const oldEventDedupeKey = `incident_resolved:agent_run:${agentRun.id}:resolve_incident:tool-old-race`;
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "The first resolution.",
      agentRunId: agentRun.id,
      eventDedupeKey: oldEventDedupeKey,
      resolvedAt: new Date("2026-07-14T11:00:00.000Z"),
    });

    let providerCloseCount = 0;
    let providerReopenCount = 0;
    const result = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: { agentRunId: agentRun.id, eventDedupeKey: oldEventDedupeKey },
      database: db,
      now: () => new Date("2026-07-14T11:10:00.000Z"),
      closePullRequest: async () => {
        providerCloseCount += 1;
        const firstResolution = one(
          await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
        );
        await createIncidentLifecycle(db).reopenManually({
          incident: firstResolution,
          actor: { userId: null },
          reopenedAt: new Date("2026-07-14T11:05:00.000Z"),
        });
        await createIncidentLifecycle(db).resolve({
          incidentId: incident.id,
          kind: "dashboard_manual",
          reasonCode: "problem_resolved",
          reasonText: "A newer resolution won.",
          eventDedupeKey: `incident_resolved:dashboard:${incident.id}:newer`,
          resolvedAt: new Date("2026-07-14T11:06:00.000Z"),
        });
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-14T11:07:00.000Z"),
        };
      },
      reopenPullRequest: async () => {
        providerReopenCount += 1;
        return { ok: true };
      },
    });

    assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
    assert.equal(providerCloseCount, 1);
    assert.equal(providerReopenCount, 0);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "closed");
    assert.equal(pullRequestAfter.closedAt?.toISOString(), "2026-07-14T11:10:00.000Z");
  } finally {
    await client.close();
  }
});
