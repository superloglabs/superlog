import assert from "node:assert/strict";
import { test } from "node:test";
import type { DB } from "./client.js";
import type * as schema from "./schema.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { createIncidentLifecycle } = await import("./resolve-incident.js");

type RecordedCall = "transaction.begin" | "incident.lock" | "pull_requests.read";

function recordingDb(opts: {
  incidentStatus: schema.IncidentStatus;
  pullRequestStates: schema.AgentPrState[];
  pendingBatchReservation?: boolean;
  reopenedAfterSettlement?: boolean;
}): { db: DB; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  // The resolver's two incidentEvents.findFirst probes arrive in a fixed
  // order: the pending-batch reservation first, then the last-reopen lookup.
  const incidentEventProbes = [
    opts.pendingBatchReservation ? { id: "reservation-1" } : undefined,
    opts.reopenedAfterSettlement
      ? { createdAt: new Date("2026-07-16T00:00:00.000Z") }
      : undefined,
  ];
  const db = {
    query: {
      incidentEvents: {
        async findFirst() {
          return incidentEventProbes.shift();
        },
      },
      agentPullRequests: {
        async findMany() {
          calls.push("pull_requests.read");
          return opts.pullRequestStates.map((state) => ({ state }));
        },
      },
    },
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    async for() {
                      calls.push("incident.lock");
                      return [
                        {
                          id: "incident-1",
                          status: opts.incidentStatus,
                          service: "api",
                        },
                      ];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) {
      calls.push("transaction.begin");
      return fn(db);
    },
  } as unknown as DB;
  return { db, calls };
}

const resolution = {
  incidentId: "incident-1",
  settlementEvidenceAt: new Date("2026-07-15T10:00:00.000Z"),
  buildInput: () => ({
    incidentId: "incident-1",
    kind: "agent_pr_closed" as const,
    reasonCode: "agent_pr_closed",
    reasonText: "Last agent PR closed without merge.",
    resolvedAt: new Date("2026-07-15T10:00:00.000Z"),
  }),
};

test("settled resolution waits while any Incident PR is still open", async () => {
  const { db, calls } = recordingDb({
    incidentStatus: "open",
    pullRequestStates: ["closed", "open"],
  });

  const result = await createIncidentLifecycle(db).resolveIfAllAgentPullRequestsSettled(resolution);

  assert.deepEqual(result, {
    disposition: "pull_requests_pending",
    resolved: false,
    resolvedIssueCount: 0,
  });
  assert.deepEqual(calls, ["transaction.begin", "incident.lock", "pull_requests.read"]);
});

test("settled resolution waits when the Incident has no PRs at all", async () => {
  const { db } = recordingDb({
    incidentStatus: "open",
    pullRequestStates: [],
  });

  const result = await createIncidentLifecycle(db).resolveIfAllAgentPullRequestsSettled(resolution);

  assert.deepEqual(result, {
    disposition: "pull_requests_pending",
    resolved: false,
    resolvedIssueCount: 0,
  });
});

test("settled resolution stops after the lock when another resolver won", async () => {
  const { db, calls } = recordingDb({
    incidentStatus: "resolved",
    pullRequestStates: ["closed"],
  });

  const result = await createIncidentLifecycle(db).resolveIfAllAgentPullRequestsSettled(resolution);

  assert.deepEqual(result, {
    disposition: "incident_not_open",
    resolved: false,
    resolvedIssueCount: 0,
  });
  assert.deepEqual(calls, ["transaction.begin", "incident.lock"]);
});

test("settlement evidence older than the last reopen cannot resolve the new epoch", async () => {
  const { db } = recordingDb({
    incidentStatus: "open",
    pullRequestStates: ["merged", "closed"],
    reopenedAfterSettlement: true,
  });

  const result = await createIncidentLifecycle(db).resolveIfAllAgentPullRequestsSettled(resolution);

  assert.deepEqual(result, {
    disposition: "resolution_event_already_consumed",
    resolved: false,
    resolvedIssueCount: 0,
  });
});

test("settled resolution defers to an in-flight PR delivery batch", async () => {
  const { db, calls } = recordingDb({
    incidentStatus: "open",
    pullRequestStates: ["closed"],
    pendingBatchReservation: true,
  });

  const result = await createIncidentLifecycle(db).resolveIfAllAgentPullRequestsSettled(resolution);

  assert.deepEqual(result, {
    disposition: "pull_requests_pending",
    resolved: false,
    resolvedIssueCount: 0,
  });
  assert.deepEqual(calls, ["transaction.begin", "incident.lock"]);
});
