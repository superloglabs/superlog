import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import type { AgentRunContext } from "../agent-run-context.js";
import {
  PullRequestDeliveryRecoveryPendingError,
  compensatePullRequestDelivery,
  deliverProposedPullRequest,
  preflightProposedPullRequest,
  publishPullRequestUpdateIfCurrent,
  pullRequestDeliveryIdentityForLegacyCompletion,
  reconcileGithubPullRequestMutation,
  reconcilePullRequestDeliveryAbortClose,
  resolvePullRequestBaseBranch,
} from "./pr-delivery.js";

test("a stale run cannot publish pull request status", async () => {
  const calls: string[] = [];
  const published = await publishPullRequestUpdateIfCurrent(
    {
      incident: { id: "incident-1" },
      agentRun: { id: "run-1" },
    } as AgentRunContext,
    "complete",
    async () => {
      calls.push("publish");
    },
    {
      canPublish: async (input) => {
        calls.push(`check:${input.state}`);
        return false;
      },
      reconcile: async () => {
        calls.push("reconcile");
      },
    },
  );

  assert.equal(published, false);
  assert.deepEqual(calls, ["check:complete"]);
});

test("pull request publication compensates when ownership changes in flight", async () => {
  const calls: string[] = [];
  let current = true;
  const published = await publishPullRequestUpdateIfCurrent(
    {
      incident: { id: "incident-1" },
      agentRun: { id: "run-1" },
    } as AgentRunContext,
    "running",
    async () => {
      calls.push("publish");
      current = false;
    },
    {
      canPublish: async (input) => {
        calls.push(`check:${input.state}:${current}`);
        return current;
      },
      reconcile: async () => {
        calls.push("reconcile");
      },
    },
  );

  assert.equal(published, false);
  assert.deepEqual(calls, ["check:running:true", "publish", "check:running:false", "reconcile"]);
});

test("legacy completion derives a stable opaque delivery identity per run and repository", () => {
  const first = pullRequestDeliveryIdentityForLegacyCompletion({
    agentRunId: "run-1",
    repoFullName: "acme/api",
    requestedBranchName: "superlog/fix-api",
    input: { patch: "first patch" },
  });
  const replay = pullRequestDeliveryIdentityForLegacyCompletion({
    agentRunId: "run-1",
    repoFullName: "acme/api",
    requestedBranchName: "superlog/fix-api",
    input: { patch: "first patch" },
  });
  const conflictingInput = pullRequestDeliveryIdentityForLegacyCompletion({
    agentRunId: "run-1",
    repoFullName: "acme/api",
    requestedBranchName: "superlog/fix-api",
    input: { patch: "different patch" },
  });

  assert.deepEqual(replay, first);
  assert.match(first.deliveryId, /^[a-zA-Z0-9_-]{8,128}$/);
  assert.equal(conflictingInput.deliveryId, first.deliveryId);
  assert.notEqual(conflictingInput.inputHash, first.inputHash);
  assert.equal(first.requestedBranchName, "superlog/fix-api");
});

test("resolvePullRequestBaseBranch prefers the configured project branch", () => {
  const ctx = { prBaseBranch: "development" } as AgentRunContext;
  const pr = { baseBranch: "main" } as schema.AgentRunPr;

  assert.equal(resolvePullRequestBaseBranch(ctx, pr), "development");
});

test("resolvePullRequestBaseBranch falls back to the agent branch when unset", () => {
  const ctx = { prBaseBranch: null } as AgentRunContext;
  const pr = { baseBranch: "main" } as schema.AgentRunPr;

  assert.equal(resolvePullRequestBaseBranch(ctx, pr), "main");
});

test("resolvePullRequestBaseBranch lets GitHub use the repository default when both are blank", () => {
  const ctx = { prBaseBranch: "   " } as AgentRunContext;
  const pr = { baseBranch: "" } as schema.AgentRunPr;

  assert.equal(resolvePullRequestBaseBranch(ctx, pr), null);
});

const deliveredPullRequest = {
  repoFullName: "acme/api",
  branchName: "ash/fix-api",
  prUrl: "https://github.com/acme/api/pull/42",
  prNumber: 42,
};

test("successful compensation makes an unrecorded PR delivery explicitly retryable", async () => {
  const calls: string[] = [];
  const providerUpdatedAt = new Date("2026-07-14T12:00:03.000Z");
  let markedClose: { providerUpdatedAt?: Date } | undefined;

  const result = await compensatePullRequestDelivery({
    pullRequest: deliveredPullRequest,
    reason: { kind: "reconciliation_failed", error: "database unavailable" },
    closePullRequest: async () => {
      calls.push("github.close");
      return { ok: true, providerUpdatedAt };
    },
    markCanonicalClosed: async (close) => {
      calls.push("canonical.close");
      markedClose = close;
      throw new Error("database still unavailable");
    },
  });

  assert.deepEqual(calls, ["github.close", "canonical.close"]);
  assert.equal(markedClose?.providerUpdatedAt, providerUpdatedAt);
  assert.equal(result.ok, false);
  assert.equal(result.deliveryStatus, "retryable");
  assert.equal(result.retryable, true);
  assert.equal(result.manualReconciliation, undefined);
});

test("an unwatermarked delivery-abort close reads provider authority before canonical state", async () => {
  const providerUpdatedAt = new Date("2026-07-14T12:00:03.000Z");
  let authoritativeReadCount = 0;
  const applied: Array<{ state: string | undefined; authoritative: boolean }> = [];

  const result = await reconcilePullRequestDeliveryAbortClose({
    close: {
      async loadAuthoritativeObservation() {
        authoritativeReadCount += 1;
        return {
          targetState: "merged" as const,
          observedAt: new Date("2026-07-14T12:00:04.000Z"),
          providerUpdatedAt,
          mergedAt: providerUpdatedAt,
          closedAt: providerUpdatedAt,
        };
      },
    },
    observedAt: new Date("2026-07-14T12:00:02.000Z"),
    async applyObservation(observation) {
      applied.push({
        state: observation.targetState,
        authoritative: observation.providerSnapshotAuthoritative === true,
      });
      return {
        canonicalRecordFound: true,
        canonicalState: "merged",
        pullRequestState: "merged",
        stateChanged: true,
        providerReconciliationRequired: false,
      };
    },
  });

  assert.equal(authoritativeReadCount, 1);
  assert.deepEqual(applied, [{ state: "merged", authoritative: true }]);
  assert.equal(result.canonicalState, "merged");
});

test("failed PR-close compensation returns structured manual-reconciliation metadata", async () => {
  let markCalled = false;

  const result = await compensatePullRequestDelivery({
    pullRequest: deliveredPullRequest,
    reason: { kind: "reconciliation_failed", error: "insert timed out" },
    closePullRequest: async () => ({ ok: false, error: "GitHub rate limited the close" }),
    markCanonicalClosed: async () => {
      markCalled = true;
      return {
        canonicalRecordFound: false,
        canonicalState: null,
        pullRequestState: null,
        stateChanged: false,
        providerReconciliationRequired: false,
      };
    },
  });

  assert.equal(markCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.deliveryStatus, "manual_reconciliation_required");
  assert.equal(result.retryable, false);
  assert.deepEqual(result.manualReconciliation, {
    actionRequired: "close_pull_request",
    repoFullName: "acme/api",
    branchName: "ash/fix-api",
    prUrl: "https://github.com/acme/api/pull/42",
    prNumber: 42,
    reconciliationReason: "reconciliation_failed",
    reconciliationError: "insert timed out",
    closeError: "GitHub rate limited the close",
    canonicalState: null,
  });
});

const deliveryIdentity = {
  deliveryId: "d4e5f60718293a4b",
  inputHash: "proposal-sha256",
  requestedBranchName: "ash/fix-api",
};

test("an ambiguous canonical commit recovers its durable delivery instead of closing the PR", async () => {
  const calls: string[] = [];
  const recordedDelivery = {
    repoFullName: "acme/api",
    requestedBranchName: "ash/fix-api",
    branchName: "ash/fix-api",
    url: "https://github.com/acme/api/pull/42",
    prNumber: 42,
    updatedExisting: false,
    headSha: "abc123",
  };

  const result = await reconcileGithubPullRequestMutation(
    {
      incidentId: "incident-1",
      agentRunId: "run-1",
      deliveryIdentity,
      pullRequest: {
        ...deliveredPullRequest,
        prNodeId: "PR_node_42",
      },
      installationId: 123,
      fallbackInstallationIds: [],
      canonicalRecordRequiredOnFailure: false,
      async reconcile() {
        calls.push("canonical.commit.ambiguous");
        throw new Error("connection lost while committing");
      },
    },
    {
      async findRecordedDelivery() {
        calls.push("delivery.recover");
        return recordedDelivery;
      },
      async compensate() {
        calls.push("github.close");
        return {
          ok: false,
          deliveryStatus: "retryable",
          retryable: true,
          error: "compensated",
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["canonical.commit.ambiguous", "delivery.recover"]);
  if (result.ok) {
    assert.deepEqual(result.deliveryReceipt, {
      newlyRecorded: false,
      delivery: recordedDelivery,
    });
  }
});

test("an absent commit-recovery receipt compensates the unrecorded pull request", async () => {
  const calls: string[] = [];

  const result = await reconcileGithubPullRequestMutation(
    {
      incidentId: "incident-1",
      agentRunId: "run-1",
      deliveryIdentity,
      pullRequest: {
        ...deliveredPullRequest,
        prNodeId: "PR_node_42",
      },
      installationId: 123,
      fallbackInstallationIds: [],
      canonicalRecordRequiredOnFailure: false,
      async reconcile() {
        calls.push("canonical.commit.ambiguous");
        throw new Error("connection lost while committing");
      },
    },
    {
      async findRecordedDelivery() {
        calls.push("delivery.recover");
        return null;
      },
      async compensate() {
        calls.push("github.close");
        return {
          ok: false,
          deliveryStatus: "retryable",
          retryable: true,
          error: "The unrecorded pull request was closed.",
        };
      },
    },
  );

  assert.deepEqual(calls, ["canonical.commit.ambiguous", "delivery.recover", "github.close"]);
  assert.deepEqual(result, {
    ok: false,
    deliveryStatus: "retryable",
    retryable: true,
    error: "The unrecorded pull request was closed.",
  });
});

test("a conflicting recovered receipt requires manual reconciliation without closing either PR", async () => {
  const calls: string[] = [];

  const result = await reconcileGithubPullRequestMutation(
    {
      incidentId: "incident-1",
      agentRunId: "run-1",
      deliveryIdentity,
      pullRequest: {
        ...deliveredPullRequest,
        prNodeId: "PR_node_42",
      },
      installationId: 123,
      fallbackInstallationIds: [],
      canonicalRecordRequiredOnFailure: false,
      async reconcile() {
        calls.push("canonical.commit.ambiguous");
        throw new Error("connection lost while committing");
      },
    },
    {
      async findRecordedDelivery() {
        calls.push("delivery.recover");
        return {
          repoFullName: "acme/api",
          requestedBranchName: "ash/fix-api",
          branchName: "ash/fix-api",
          url: "https://github.com/acme/api/pull/99",
          prNumber: 99,
          updatedExisting: false,
          headSha: "def456",
        };
      },
      async compensate() {
        calls.push("github.close");
        return {
          ok: false,
          deliveryStatus: "retryable",
          retryable: true,
          error: "compensated",
        };
      },
    },
  );

  assert.deepEqual(calls, ["canonical.commit.ambiguous", "delivery.recover"]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.deliveryStatus, "manual_reconciliation_required");
  assert.equal(result.retryable, false);
  assert.equal(result.manualReconciliation.actionRequired, "sync_canonical_state");
});

test("a failed commit-recovery read remains pending without closing an ambiguous PR", async () => {
  const calls: string[] = [];

  await assert.rejects(
    reconcileGithubPullRequestMutation(
      {
        incidentId: "incident-1",
        agentRunId: "run-1",
        deliveryIdentity,
        pullRequest: {
          ...deliveredPullRequest,
          prNodeId: "PR_node_42",
        },
        installationId: 123,
        fallbackInstallationIds: [],
        canonicalRecordRequiredOnFailure: false,
        async reconcile() {
          calls.push("canonical.commit.ambiguous");
          throw new Error("connection lost while committing");
        },
      },
      {
        async findRecordedDelivery() {
          calls.push("delivery.recover");
          throw new Error("database unavailable during recovery");
        },
        async compensate() {
          calls.push("github.close");
          return {
            ok: false,
            deliveryStatus: "retryable",
            retryable: true,
            error: "compensated",
          };
        },
      },
    ),
    PullRequestDeliveryRecoveryPendingError,
  );

  assert.deepEqual(calls, ["canonical.commit.ambiguous", "delivery.recover"]);
});

const recordedDelivery = {
  repoFullName: "acme/api",
  requestedBranchName: "ash/fix-api",
  branchName: "ash/fix-api-retry-d4e5f607",
  url: "https://github.com/acme/api/pull/42",
  prNumber: 42,
  updatedExisting: false,
  headSha: "abc123",
};

const proposedPullRequest = {
  repoFullName: "acme/api",
  title: "Fix API retries",
  body: "The retry loop now terminates.",
  branchName: "ash/fix-api",
  baseBranch: "main",
  patchFilePath: "/mnt/session/outputs/api.patch",
};

test("preflight reconstructs a recorded entry before policy or provider checks", async () => {
  const prepared = await preflightProposedPullRequest(
    {
      prPolicy: "never",
      githubInstalls: [],
      incident: { id: "incident-1" },
      agentRun: { id: "run-1" },
    } as unknown as AgentRunContext,
    proposedPullRequest,
    "session-1",
    deliveryIdentity,
    {
      findRecordedDelivery: async () => recordedDelivery,
      listRepositories: async () => {
        throw new Error("provider lookup must not run");
      },
    },
  );

  assert.deepEqual(prepared, {
    ok: true,
    prepared: { kind: "recorded", delivery: recordedDelivery },
  });
});

test("preflight recognizes a pushed delivery branch before reading or applying the patch", async () => {
  let downloaded = false;
  let validated = false;
  const prepared = await preflightProposedPullRequest(
    {
      prPolicy: "always",
      githubInstalls: [{ installation: { installationId: 99 } }],
      incident: { id: "incident-1" },
      agentRun: { id: "run-1" },
    } as unknown as AgentRunContext,
    proposedPullRequest,
    "session-1",
    deliveryIdentity,
    {
      findRecordedDelivery: async () => null,
      listRepositories: async () => [
        {
          id: 123,
          fullName: "acme/api",
          private: false,
          installation: { installationId: 99 } as never,
        },
      ],
      findGithubDelivery: async () => ({
        kind: "branch",
        branchName: "ash/fix-api-retry-d4e5f607",
        headSha: "abc123",
        baseBranch: "main",
      }),
      downloadPatch: async () => {
        downloaded = true;
        return { patch: "diff", fileId: "file-1" };
      },
      validatePatch: async () => {
        validated = true;
      },
    },
  );

  assert.deepEqual(prepared, { ok: true, prepared: { kind: "github_recovery" } });
  assert.equal(downloaded, false);
  assert.equal(validated, false);
});

test("delivery returns a recorded entry without repeating provider side effects", async () => {
  const result = await deliverProposedPullRequest(
    {
      prPolicy: "never",
      githubInstalls: [],
    } as unknown as AgentRunContext,
    proposedPullRequest,
    "session-1",
    null,
    { kind: "recorded", delivery: recordedDelivery },
    deliveryIdentity,
  );

  assert.deepEqual(result, {
    ok: true,
    url: recordedDelivery.url,
    prNumber: recordedDelivery.prNumber,
    branchName: recordedDelivery.branchName,
    updatedExisting: false,
  });
});
