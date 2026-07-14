import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type DB, schema } from "@superlog/db";
import {
  decidePullRequestMutationReconciliation,
  findRecordedPullRequestDelivery,
  markAgentPullRequestClosedAfterDeliveryAbort,
  recordOpenedAgentPullRequest,
  recordUpdatedAgentPullRequest,
  resolveIncidentOrgBestEffort,
} from "./deliverable-records.js";

type RecordedCall =
  | "transaction.begin"
  | "incident.lock"
  | "pull_request.insert"
  | "pull_request.update"
  | "pull_request.close"
  | "pull_request_event.insert"
  | "delivery_receipt.insert"
  | "transaction.end";

function recordingPullRequestDb(opts: {
  incidentStatus: schema.IncidentStatus;
  canonicalState?: schema.AgentPrState;
  pullRequestInsertConflicts?: boolean;
  recordedDeliveryDetail?: Record<string, unknown>;
}): {
  database: DB;
  calls: RecordedCall[];
  insertedPullRequest: () => Record<string, unknown> | null;
} {
  const calls: RecordedCall[] = [];
  let insertedPullRequestValues: Record<string, unknown> | null = null;
  const database = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async for() {
                  calls.push("incident.lock");
                  return [{ status: opts.incidentStatus }];
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
          if (table === schema.agentPullRequests) {
            insertedPullRequestValues = values;
            return {
              onConflictDoNothing() {
                return {
                  async returning() {
                    calls.push("pull_request.insert");
                    if (opts.pullRequestInsertConflicts) return [];
                    return [
                      {
                        id: "pr-record-1",
                        incidentId: "incident-1",
                        state: opts.canonicalState ?? "open",
                      },
                    ];
                  },
                };
              },
            };
          }
          if (table === schema.incidentEvents) {
            return {
              onConflictDoNothing() {
                return {
                  async returning() {
                    calls.push("delivery_receipt.insert");
                    return [{ id: "receipt-1" }];
                  },
                };
              },
            };
          }
          return {
            async onConflictDoNothing() {
              calls.push("pull_request_event.insert");
            },
          };
        },
      };
    },
    update(table: unknown) {
      assert.equal(table, schema.agentPullRequests);
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                async returning() {
                  const closing = values.state === "closed";
                  calls.push(closing ? "pull_request.close" : "pull_request.update");
                  return [
                    {
                      id: "pr-record-1",
                      incidentId: "incident-1",
                      state: closing ? "closed" : (opts.canonicalState ?? "open"),
                    },
                  ];
                },
              };
            },
          };
        },
      };
    },
    query: {
      incidentEvents: {
        async findFirst() {
          return opts.recordedDeliveryDetail ? { detail: opts.recordedDeliveryDetail } : undefined;
        },
      },
      agentPullRequests: {
        async findFirst() {
          return {
            id: "pr-record-1",
            incidentId: "incident-1",
            state: opts.canonicalState ?? "open",
          };
        },
      },
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) {
      calls.push("transaction.begin");
      const result = await fn(database);
      calls.push("transaction.end");
      return result;
    },
  } as unknown as DB;
  return {
    database,
    calls,
    insertedPullRequest: () => insertedPullRequestValues,
  };
}

const openedPullRequest = {
  incidentId: "incident-1",
  agentRunId: "run-1",
  installationRowId: "installation-1",
  repoFullName: "acme/api",
  prNumber: 42,
  prNodeId: "PR_node_42",
  url: "https://github.com/acme/api/pull/42",
  branchName: "ash/fix-api",
  baseBranch: "main",
  headSha: "abc123",
  title: "Fix API",
  authorLogin: "octocat",
  authorGithubId: 1,
  authorAvatarUrl: null,
  state: "open" as const,
  mergedAt: null,
};

test("resolveIncidentOrgBestEffort preserves ticket completion when org lookup fails", async () => {
  const org = await resolveIncidentOrgBestEffort(async () => {
    throw new Error("database temporarily unavailable");
  });

  assert.equal(org, null);
});

test("PR reconciliation requires compensation when incident resolution won the row lock", () => {
  assert.deepEqual(
    decidePullRequestMutationReconciliation({
      incidentStatus: "resolved",
      canonicalState: "open",
    }),
    {
      kind: "close_pull_request",
      reason: "incident_not_open",
      incidentStatus: "resolved",
      canonicalState: "open",
    },
  );
});

test("incident resolution prevents a per-entry delivery receipt from committing", async () => {
  const { database, calls } = recordingPullRequestDb({ incidentStatus: "resolved" });

  const result = await recordOpenedAgentPullRequest(
    {
      ...openedPullRequest,
      deliveryIdentity: {
        deliveryId: "d4e5f60718293a4b",
        inputHash: "proposal-sha256",
        requestedBranchName: "ash/fix-api",
      },
    },
    { database, recordCreatedMetric: async () => {} },
  );

  assert.equal(result.kind, "close_pull_request");
  assert.equal(calls.includes("delivery_receipt.insert"), false);
});

test("recording an opened PR locks the incident before writing the canonical record", async () => {
  const { database, calls } = recordingPullRequestDb({ incidentStatus: "resolved" });

  const result = await recordOpenedAgentPullRequest(openedPullRequest, {
    database,
    recordCreatedMetric: async () => {},
  });

  assert.equal(result.kind, "close_pull_request");
  assert.deepEqual(calls, [
    "transaction.begin",
    "incident.lock",
    "pull_request.insert",
    "pull_request_event.insert",
    "transaction.end",
  ]);
});

test("an opened PR and its per-entry delivery receipt commit under the same incident lock", async () => {
  const { database, calls } = recordingPullRequestDb({ incidentStatus: "open" });

  const result = await recordOpenedAgentPullRequest(
    {
      ...openedPullRequest,
      deliveryIdentity: {
        deliveryId: "d4e5f60718293a4b",
        inputHash: "proposal-sha256",
        requestedBranchName: "ash/fix-api",
      },
    },
    { database, recordCreatedMetric: async () => {} },
  );

  assert.equal(result.kind, "deliver");
  assert.deepEqual(result.deliveryReceipt, {
    newlyRecorded: true,
    delivery: {
      repoFullName: "acme/api",
      requestedBranchName: "ash/fix-api",
      branchName: "ash/fix-api",
      url: "https://github.com/acme/api/pull/42",
      prNumber: 42,
      updatedExisting: false,
      headSha: "abc123",
    },
  });
  assert.deepEqual(calls, [
    "transaction.begin",
    "incident.lock",
    "pull_request.insert",
    "pull_request_event.insert",
    "delivery_receipt.insert",
    "transaction.end",
  ]);
});

test("receipt-loss recovery records an already-merged pull request as terminal", async () => {
  const mergedAt = new Date("2026-07-14T12:00:00Z");
  const { database, insertedPullRequest } = recordingPullRequestDb({
    incidentStatus: "open",
    canonicalState: "merged",
  });

  const result = await recordOpenedAgentPullRequest(
    {
      ...openedPullRequest,
      state: "merged",
      mergedAt,
    },
    { database, recordCreatedMetric: async () => {} },
  );

  assert.equal(result.kind, "deliver");
  assert.equal(insertedPullRequest()?.state, "merged");
  assert.equal(insertedPullRequest()?.mergedAt, mergedAt);
});

test("terminal recovery commits its receipt while the webhook transition is pending", async () => {
  const mergedAt = new Date("2026-07-14T12:00:00Z");
  const { database, calls } = recordingPullRequestDb({
    incidentStatus: "open",
    canonicalState: "open",
    pullRequestInsertConflicts: true,
  });

  const result = await recordOpenedAgentPullRequest(
    {
      ...openedPullRequest,
      state: "merged",
      mergedAt,
      deliveryIdentity: {
        deliveryId: "d4e5f60718293a4b",
        inputHash: "proposal-sha256",
        requestedBranchName: "ash/fix-api",
      },
    },
    { database, recordCreatedMetric: async () => {} },
  );

  assert.equal(result.kind, "deliver");
  assert.equal(result.newlyInserted, false);
  assert.equal(calls.includes("pull_request.update"), false);
  assert.ok(calls.includes("delivery_receipt.insert"));
});

test("a post-commit metric failure cannot unwind a recorded PR delivery", async () => {
  const { database } = recordingPullRequestDb({ incidentStatus: "open" });

  const result = await recordOpenedAgentPullRequest(openedPullRequest, {
    database,
    recordCreatedMetric: async () => {
      throw new Error("metrics backend unavailable");
    },
  });

  assert.equal(result.kind, "deliver");
});

test("a recorded per-entry delivery is reconstructed only for the same input", async () => {
  const identity = {
    deliveryId: "d4e5f60718293a4b",
    inputHash: "proposal-sha256",
    requestedBranchName: "ash/fix-api",
  };
  const { database } = recordingPullRequestDb({
    incidentStatus: "open",
    recordedDeliveryDetail: {
      ...identity,
      repoFullName: "acme/api",
      branchName: "ash/fix-api-retry-d4e5f607",
      url: "https://github.com/acme/api/pull/42",
      prNumber: 42,
      updatedExisting: false,
      headSha: "abc123",
    },
  });

  const recovered = await findRecordedPullRequestDelivery(
    {
      incidentId: "incident-1",
      agentRunId: "run-1",
      repoFullName: "acme/api",
      identity,
    },
    database,
  );
  await assert.rejects(
    findRecordedPullRequestDelivery(
      {
        incidentId: "incident-1",
        agentRunId: "run-1",
        repoFullName: "acme/api",
        identity: { ...identity, inputHash: "different-proposal" },
      },
      database,
    ),
    /conflicted with different input/,
  );

  assert.equal(recovered?.branchName, "ash/fix-api-retry-d4e5f607");
});

test("recording an existing PR update locks the incident before updating the canonical record", async () => {
  const { database, calls } = recordingPullRequestDb({ incidentStatus: "open" });

  const result = await recordUpdatedAgentPullRequest(
    {
      incidentId: "incident-1",
      agentPullRequestId: "pr-record-1",
      repoFullName: "acme/api",
      prNumber: 42,
      headSha: "def456",
    },
    { database },
  );

  assert.deepEqual(result, {
    kind: "deliver",
    agentPullRequestId: "pr-record-1",
    newlyInserted: false,
  });
  assert.deepEqual(calls, [
    "transaction.begin",
    "incident.lock",
    "pull_request.update",
    "transaction.end",
  ]);
});

test("an existing PR update atomically records the exact delivery entry", async () => {
  const { database, calls } = recordingPullRequestDb({ incidentStatus: "open" });

  const result = await recordUpdatedAgentPullRequest(
    {
      incidentId: "incident-1",
      agentRunId: "run-1",
      agentPullRequestId: "pr-record-1",
      repoFullName: "acme/api",
      prNumber: 42,
      url: "https://github.com/acme/api/pull/42",
      branchName: "ash/fix-api",
      headSha: "def456",
      deliveryIdentity: {
        deliveryId: "d4e5f60718293a4b",
        inputHash: "proposal-sha256",
        requestedBranchName: "ash/fix-api",
      },
    },
    { database },
  );

  assert.equal(result.kind, "deliver");
  assert.equal(result.deliveryReceipt?.newlyRecorded, true);
  assert.equal(result.deliveryReceipt?.delivery.updatedExisting, true);
  assert.deepEqual(calls, [
    "transaction.begin",
    "incident.lock",
    "pull_request.update",
    "delivery_receipt.insert",
    "transaction.end",
  ]);
});

test("marking an aborted delivery closes its canonical record and records the transition", async () => {
  const { database, calls } = recordingPullRequestDb({ incidentStatus: "resolved" });

  const result = await markAgentPullRequestClosedAfterDeliveryAbort(
    {
      repoFullName: "acme/api",
      prNumber: 42,
      reason: "incident_not_open",
    },
    { database, now: () => new Date("2026-07-14T12:00:00.000Z") },
  );

  assert.deepEqual(result, { canonicalRecordFound: true, canonicalState: "closed" });
  assert.deepEqual(calls, [
    "transaction.begin",
    "pull_request.close",
    "pull_request_event.insert",
    "transaction.end",
  ]);
});
