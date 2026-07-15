import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequestProposal } from "../agent-outcome-tools.js";
import { PullRequestDeliveryReceiptConflictError } from "./deliverable-records.js";
import {
  type OutcomeActionReceiptLock,
  outcomeActionInputHash,
} from "./outcome-action-receipts.js";
import {
  createOutcomeActionExecutor,
  executeProposedPullRequestBatch,
  missingMobileTestDecision,
  proposedPullRequestBatchErrors,
  pullRequestDeliveryIdentityForOutcomeAction,
} from "./outcome-actions.js";
import { PullRequestDeliveryRecoveryPendingError } from "./pr-delivery.js";

const proposals: PullRequestProposal[] = [
  {
    repoFullName: "acme/api",
    title: "[superlog] Fix API retries",
    body: "# Summary",
    branchName: "superlog/fix-api-retries",
    baseBranch: "main",
    patchFilePath: "/mnt/session/outputs/api.patch",
  },
  {
    repoFullName: "acme/worker",
    title: "[superlog] Align worker timeout",
    body: "# Summary",
    branchName: "superlog/align-worker-timeout",
    baseBranch: "main",
    patchFilePath: "/mnt/session/outputs/worker.patch",
  },
];

const manualReconciliation = {
  actionRequired: "close_pull_request" as const,
  repoFullName: "acme/api",
  branchName: "superlog/fix-api-retries",
  prUrl: "https://github.com/acme/api/pull/42",
  prNumber: 42,
  reconciliationReason: "reconciliation_failed" as const,
  reconciliationError: "canonical write timed out",
  closeError: "GitHub rate limited the close",
  canonicalState: null,
};

const receiptContext = {
  incident: { id: "incident-1" },
  agentRun: { id: "run-1" },
} as Parameters<typeof createOutcomeActionExecutor>[0];

const noReceiptLock: OutcomeActionReceiptLock = {
  async exclusive(_args, task) {
    return task({
      async load() {
        return null;
      },
      async save() {},
    });
  },
};

test("the whole PR batch is preflighted before any repository is changed", async () => {
  const calls: string[] = [];
  const result = await executeProposedPullRequestBatch(proposals, {
    preflight: async (proposal) => {
      calls.push(`preflight:${proposal.repoFullName}`);
      return proposal.repoFullName === "acme/worker"
        ? { ok: false, error: "patch does not apply" }
        : { ok: true, prepared: "api-patch" };
    },
    deliver: async (proposal) => {
      calls.push(`deliver:${proposal.repoFullName}`);
      return {
        ok: true as const,
        url: `https://github.com/${proposal.repoFullName}/pull/1`,
        prNumber: 1,
        branchName: proposal.branchName,
        updatedExisting: false,
      };
    },
  });

  assert.deepEqual(calls, ["preflight:acme/api", "preflight:acme/worker"]);
  assert.equal(result.ok, false);
  assert.equal(result.pullRequests.length, 2);
  assert.equal(result.pullRequests[0]?.status, "not_delivered");
  assert.equal(result.pullRequests[1]?.status, "validation_failed");
  assert.match(proposedPullRequestBatchErrors(result)[0] ?? "", /retry every.*entry/i);
});

test("delivery reports every entry and permits retrying only external failures", async () => {
  let activeDeliveries = 0;
  let maxActiveDeliveries = 0;
  const result = await executeProposedPullRequestBatch(proposals, {
    preflight: async (proposal) => ({ ok: true, prepared: proposal.repoFullName }),
    deliver: async (proposal) => {
      activeDeliveries += 1;
      maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeDeliveries -= 1;
      return proposal.repoFullName === "acme/api"
        ? {
            ok: true,
            url: "https://github.com/acme/api/pull/12",
            prNumber: 12,
            branchName: proposal.branchName,
            updatedExisting: false,
          }
        : { ok: false, error: "GitHub unavailable" };
    },
  });

  assert.equal(maxActiveDeliveries, 1);
  assert.equal(result.ok, false);
  assert.equal(result.pullRequests[0]?.status, "delivered");
  assert.equal(result.pullRequests[1]?.status, "delivery_failed");
  assert.match(proposedPullRequestBatchErrors(result)[0] ?? "", /not delivered/i);
});

test("a compensated delivery failure preserves its explicit retryable status", async () => {
  const [proposal] = proposals;
  assert.ok(proposal);
  const result = await executeProposedPullRequestBatch([proposal], {
    preflight: async () => ({ ok: true, prepared: "patch" }),
    deliver: async () => ({
      ok: false,
      error: "The just-opened PR was closed after recording failed.",
      deliveryStatus: "retryable",
      retryable: true,
    }),
  });

  assert.deepEqual(result.pullRequests, [
    {
      repoFullName: proposal.repoFullName,
      branchName: proposal.branchName,
      status: "delivery_failed",
      deliveryStatus: "retryable",
      retryable: true,
      error: "The just-opened PR was closed after recording failed.",
    },
  ]);
  assert.match(proposedPullRequestBatchErrors(result)[0] ?? "", /retry/i);
});

test("incident-not-open stops the batch and forbids another PR attempt", async () => {
  const deliveredRepos: string[] = [];
  const result = await executeProposedPullRequestBatch(proposals, {
    preflight: async () => ({ ok: true, prepared: "patch" }),
    deliver: async (proposal) => {
      deliveredRepos.push(proposal.repoFullName);
      return {
        ok: false,
        error: "Incident resolution won; the PR was closed.",
        deliveryStatus: "incident_not_open",
        retryable: false,
        incidentStatus: "resolved",
      };
    },
  });

  assert.deepEqual(deliveredRepos, ["acme/api"]);
  assert.equal(result.pullRequests[0]?.deliveryStatus, "incident_not_open");
  assert.equal(result.pullRequests[0]?.retryable, false);
  assert.equal(result.pullRequests[1]?.status, "not_delivered");
  assert.match(proposedPullRequestBatchErrors(result).join(" "), /do not retry/i);
  assert.match(proposedPullRequestBatchErrors(result).join(" "), /resolve_incident|ask_human/i);
});

test("manual reconciliation metadata survives the batch boundary and blocks later mutations", async () => {
  const deliveredRepos: string[] = [];
  const result = await executeProposedPullRequestBatch(proposals, {
    preflight: async () => ({ ok: true, prepared: "patch" }),
    deliver: async (proposal) => {
      deliveredRepos.push(proposal.repoFullName);
      return {
        ok: false,
        error: "The PR may still be open and requires a human.",
        deliveryStatus: "manual_reconciliation_required",
        retryable: false,
        manualReconciliation,
      };
    },
  });

  assert.deepEqual(deliveredRepos, ["acme/api"]);
  assert.deepEqual(result.pullRequests[0]?.manualReconciliation, manualReconciliation);
  assert.equal(result.pullRequests[0]?.deliveryStatus, "manual_reconciliation_required");
  assert.equal(result.pullRequests[1]?.status, "not_delivered");
  assert.match(proposedPullRequestBatchErrors(result).join(" "), /do not retry|do not.*mutation/i);
  assert.match(proposedPullRequestBatchErrors(result).join(" "), /ask_human/i);
});

test("a thrown delivery preserves earlier successful entries", async () => {
  const result = await executeProposedPullRequestBatch(proposals, {
    preflight: async (proposal) => ({ ok: true, prepared: proposal.repoFullName }),
    deliver: async (proposal) => {
      if (proposal.repoFullName === "acme/worker") throw new Error("provider timeout");
      return {
        ok: true as const,
        url: "https://github.com/acme/api/pull/12",
        prNumber: 12,
        branchName: proposal.branchName,
        updatedExisting: false,
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.pullRequests[0]?.status, "delivered");
  assert.equal(result.pullRequests[0]?.prUrl, "https://github.com/acme/api/pull/12");
  assert.equal(result.pullRequests[1]?.status, "delivery_failed");
  assert.match(result.pullRequests[1]?.error ?? "", /provider timeout/);
});

test("the mobile regression gate retries when integration lookup fails", async () => {
  const proposal = proposals[0];
  assert.ok(proposal);
  await assert.rejects(
    missingMobileTestDecision(
      {
        project: { orgId: "org-1" },
        incident: { service: "ios" },
      } as Parameters<typeof missingMobileTestDecision>[0],
      {
        ...proposal,
        changedFiles: ["ios/CheckoutView.swift"],
      },
      async () => {
        throw new Error("integration store unavailable");
      },
    ),
    /could not verify the mobile regression integration/i,
  );
});

test("retired outcome tools are handled with migration guidance", async () => {
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock);
  const result = await execute({
    toolUseId: "tool-use-1",
    name: "mark_already_resolved",
    input: { reason: "The upstream recovered.", evidence: "The signal cleared." },
    hasFindings: true,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.payload), /resolve_incident\.issueOutcomes/);
});

test("a durable legacy issue action is error-acked with classification-at-resolution guidance", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const dependencies = {
    async classifyIncidentIssue(_database: unknown, input: Record<string, unknown>) {
      calls.push(input);
      return {
        ok: true,
        issueTitle: "Expected probe",
        status: "silenced",
        alreadyClassified: true,
      };
    },
    async finalizeFulfilledAgentPullRequestBatches() {
      return 0;
    },
  };
  const execute = createOutcomeActionExecutor(
    receiptContext,
    "session-1",
    noReceiptLock,
    dependencies,
  );

  const result = await execute({
    toolUseId: "legacy-action-1",
    name: "silence_as_noise",
    input: {
      issueId: "issue-1",
      reason: "Expected probe traffic.",
      evidence: "The handler returned its documented no-op response.",
    },
    hasFindings: true,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, false);
  assert.equal(result.payload.final, undefined);
  assert.match(JSON.stringify(result.payload), /resolve_incident\.issueOutcomes/);
  assert.equal(calls.length, 0);
});

test("resolve_incident stays non-terminal while a canonical pull request is open", async () => {
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async synthesizeLegacyIncidentIssueOutcomes() {
      return { ok: true, outcomes: [] };
    },
    async resolveAgentIncident() {
      return {
        disposition: "pull_requests_open" as const,
        resolved: false as const,
        resolvedIssueCount: 0 as const,
        pullRequests: [
          {
            repoFullName: "acme/api",
            prNumber: 42,
            url: "https://github.com/acme/api/pull/42",
          },
        ],
      };
    },
  });

  const result = await execute({
    toolUseId: "resolve-with-open-pr",
    name: "resolve_incident",
    input: {
      reason: "The patch is ready.",
      evidence: "The regression test passes.",
    },
    hasFindings: true,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, false);
  assert.equal(result.payload.final, undefined);
  assert.match(JSON.stringify(result.payload), /acme\/api.*42/);
  assert.match(JSON.stringify(result.payload), /open pull request/i);
});

test("resolve_incident stays non-terminal while pull request delivery is pending", async () => {
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async synthesizeLegacyIncidentIssueOutcomes() {
      return { ok: true, outcomes: [] };
    },
    async resolveAgentIncident() {
      return {
        disposition: "pull_request_delivery_pending" as const,
        resolved: false as const,
        resolvedIssueCount: 0 as const,
      };
    },
  });

  const result = await execute({
    toolUseId: "resolve-during-pr-delivery",
    name: "resolve_incident",
    input: {
      reason: "The patch is ready.",
      evidence: "The regression test passes.",
    },
    hasFindings: true,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, false);
  assert.equal(result.payload.final, undefined);
  assert.match(JSON.stringify(result.payload), /still being delivered/i);
});

test("resolve_incident corrects a stale run after the Incident was reopened", async () => {
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async synthesizeLegacyIncidentIssueOutcomes() {
      return { ok: true, outcomes: [] };
    },
    async resolveAgentIncident() {
      return {
        disposition: "agent_run_not_current" as const,
        resolved: false as const,
        resolvedIssueCount: 0 as const,
      };
    },
  });

  const result = await execute({
    toolUseId: "resolve-from-stale-run",
    name: "resolve_incident",
    input: {
      reason: "The old investigation believes the work is complete.",
      evidence: "This snapshot predates the manual reopen.",
    },
    hasFindings: true,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, false);
  assert.equal(result.payload.final, undefined);
  assert.match(JSON.stringify(result.payload), /no longer the current investigation/i);
});

test("resolve_incident rejects a terminal decision consumed by an older Incident epoch", async () => {
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async synthesizeLegacyIncidentIssueOutcomes() {
      return { ok: true, outcomes: [] };
    },
    async resolveAgentIncident() {
      return {
        disposition: "resolution_event_already_consumed" as const,
        resolved: false as const,
        resolvedIssueCount: 0 as const,
      };
    },
  });

  const result = await execute({
    toolUseId: "replayed-resolution-decision",
    name: "resolve_incident",
    input: {
      reason: "The prior epoch was complete.",
      evidence: "This decision was already consumed before the manual reopen.",
    },
    hasFindings: true,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, false);
  assert.equal(result.payload.final, undefined);
  assert.match(JSON.stringify(result.payload), /earlier Incident epoch/i);
});

test("legacy resolve synthesizes complete issue outcomes and uses tool-specific atomic proof", async () => {
  const resolveCalls: Array<Record<string, unknown>> = [];
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async synthesizeLegacyIncidentIssueOutcomes() {
      return {
        ok: true,
        outcomes: [
          {
            issueId: "issue-1",
            action: "observe",
            reason: "Watch the one-off.",
            evidence: "Only one occurrence was observed.",
            trigger: { kind: "count", count: 25 },
          },
          {
            issueId: "issue-2",
            action: "resolve",
            reason: "The transient condition recovered.",
            evidence: "The error remained absent for 30 minutes.",
          },
        ],
      };
    },
    async resolveAgentIncident(input) {
      resolveCalls.push(input as unknown as Record<string, unknown>);
      return {
        disposition: "resolved" as const,
        resolved: true as const,
        resolvedIssueCount: 2,
      };
    },
  });

  const result = await execute({
    toolUseId: "legacy-resolve-1",
    name: "resolve_incident",
    input: {
      reason: "Every legacy classification is complete.",
      evidence: "The failing signal has remained at zero for 30 minutes.",
    },
    hasFindings: true,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, true);
  assert.equal(result.payload.final, true);
  assert.equal(
    result.payload.incidentResolutionEventDedupeKey,
    "incident_resolved:agent_run:run-1:resolve_incident:legacy-resolve-1",
  );
  assert.deepEqual(result.payload.issueOutcomes, [
    {
      issueId: "issue-1",
      status: "under_observation",
      reason: "Watch the one-off.",
      evidence: "Only one occurrence was observed.",
      escalateOn: "additional_events",
      threshold: 25,
    },
    {
      issueId: "issue-2",
      status: "resolved",
      reason: "The transient condition recovered.",
      evidence: "The error remained absent for 30 minutes.",
    },
  ]);
  assert.equal(resolveCalls.length, 1);
  assert.deepEqual(resolveCalls[0]?.issueOutcomes, [
    {
      issueId: "issue-1",
      action: "observe",
      reason: "Watch the one-off.",
      evidence: "Only one occurrence was observed.",
      trigger: { kind: "count", count: 25 },
    },
    {
      issueId: "issue-2",
      action: "resolve",
      reason: "The transient condition recovered.",
      evidence: "The error remained absent for 30 minutes.",
    },
  ]);
});

test("a replayed tool use returns its durable execution receipt without repeating side effects", async () => {
  let saved = false;
  const receiptLock: OutcomeActionReceiptLock = {
    async exclusive(args, task) {
      assert.equal(args.toolUseId, "tool-use-replayed");
      assert.equal(args.toolName, "propose_pr");
      return task({
        async load() {
          return {
            version: 1,
            toolName: "propose_pr",
            inputHash: outcomeActionInputHash({}),
            ok: true,
            payload: {
              ok: true,
              final: true,
              pullRequests: [
                {
                  repoFullName: "acme/api",
                  branchName: "superlog/fix-api-retries",
                  status: "delivered",
                  prUrl: "https://github.com/acme/api/pull/12",
                },
              ],
            },
          };
        },
        async save() {
          saved = true;
        },
      });
    },
  };
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", receiptLock);

  const result = await execute({
    toolUseId: "tool-use-replayed",
    name: "propose_pr",
    input: {},
    hasFindings: false,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, true);
  assert.equal(saved, false);
  assert.equal(Array.isArray(result.payload.pullRequests), true);
});

test("PR delivery identity is stable and scoped to run, tool use, and repository", () => {
  const proposal = proposals[0];
  assert.ok(proposal);

  const first = pullRequestDeliveryIdentityForOutcomeAction("run-1", "tool-1", proposal);
  const replay = pullRequestDeliveryIdentityForOutcomeAction("run-1", "tool-1", {
    ...proposal,
  });

  assert.deepEqual(replay, first);
  assert.match(first.deliveryId, /^[a-f0-9]{64}$/);
  assert.equal(first.inputHash, outcomeActionInputHash(proposal));
  assert.equal(first.requestedBranchName, proposal.branchName);
  assert.notEqual(
    pullRequestDeliveryIdentityForOutcomeAction("run-1", "tool-2", proposal).deliveryId,
    first.deliveryId,
  );
  assert.notEqual(
    pullRequestDeliveryIdentityForOutcomeAction("run-1", "tool-1", {
      ...proposal,
      repoFullName: "acme/other",
    }).deliveryId,
    first.deliveryId,
  );
});

test("propose_pr passes the same delivery identity through preflight and delivery", async () => {
  const proposal = proposals[0];
  assert.ok(proposal);
  const identities: unknown[] = [];
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async preflightProposedPullRequest(_ctx, _proposal, _sessionId, identity) {
      identities.push(identity);
      return { ok: true, prepared: { kind: "patch", patch: "diff --git a/a b/a" } };
    },
    async deliverProposedPullRequest(_ctx, _proposal, _sessionId, _findings, _prepared, identity) {
      identities.push(identity);
      return {
        ok: true,
        url: "https://github.com/acme/api/pull/12",
        prNumber: 12,
        branchName: proposal.branchName,
        updatedExisting: false,
      };
    },
    async finalizeFulfilledAgentPullRequestBatches() {
      return 0;
    },
  });

  const result = await execute({
    toolUseId: "proposal-tool-1",
    name: "propose_pr",
    input: { pullRequests: [proposal] },
    hasFindings: true,
    findings: { summary: "API retries fail after a provider timeout." },
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, true);
  assert.equal(identities.length, 2);
  assert.deepEqual(identities[1], identities[0]);
});

test("multi-repository propose_pr reserves the full batch before delivery and finalizes afterward", async () => {
  const calls: string[] = [];
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async reserveAgentPullRequestBatch(_db, input) {
      calls.push(`reserve:${input.deliveries.map(({ repoFullName }) => repoFullName).join(",")}`);
      return true;
    },
    async finalizeFulfilledAgentPullRequestBatches() {
      calls.push("finalize");
      return 1;
    },
    async preflightProposedPullRequest(_ctx, proposal) {
      calls.push(`preflight:${proposal.repoFullName}`);
      return { ok: true, prepared: { kind: "patch", patch: "diff --git a/a b/a" } };
    },
    async deliverProposedPullRequest(_ctx, proposal) {
      calls.push(`deliver:${proposal.repoFullName}`);
      return {
        ok: true,
        url: `https://github.com/${proposal.repoFullName}/pull/12`,
        prNumber: 12,
        branchName: proposal.branchName,
        updatedExisting: false,
      };
    },
  });

  const result = await execute({
    toolUseId: "proposal-tool-batch",
    name: "propose_pr",
    input: { pullRequests: proposals },
    hasFindings: true,
    findings: { summary: "Two repositories require coordinated fixes." },
  });

  assert.equal(result.handled, true);
  assert.deepEqual(calls, [
    "preflight:acme/api",
    "preflight:acme/worker",
    "reserve:acme/api,acme/worker",
    "deliver:acme/api",
    "deliver:acme/worker",
    "finalize",
  ]);
});

test("an exact recorded batch replay succeeds without reserving or resolving again", async () => {
  const calls: string[] = [];
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async reserveAgentPullRequestBatch() {
      calls.push("reserve");
      return false;
    },
    async finalizeFulfilledAgentPullRequestBatches() {
      calls.push("finalize");
      return 0;
    },
    async preflightProposedPullRequest(_ctx, proposal) {
      calls.push(`preflight:${proposal.repoFullName}`);
      return {
        ok: true,
        prepared: {
          kind: "recorded" as const,
          delivery: {
            repoFullName: proposal.repoFullName,
            requestedBranchName: proposal.branchName,
            branchName: proposal.branchName,
            url: `https://github.com/${proposal.repoFullName}/pull/12`,
            prNumber: 12,
            updatedExisting: false,
            headSha: "abc123",
          },
        },
      };
    },
    async deliverProposedPullRequest(_ctx, proposal) {
      calls.push(`deliver:${proposal.repoFullName}`);
      return {
        ok: true,
        url: `https://github.com/${proposal.repoFullName}/pull/12`,
        prNumber: 12,
        branchName: proposal.branchName,
        updatedExisting: false,
      };
    },
  });

  const result = await execute({
    toolUseId: "proposal-tool-recorded-replay",
    name: "propose_pr",
    input: { pullRequests: proposals },
    hasFindings: true,
    findings: { summary: "Both fixes were delivered before the acknowledgement was saved." },
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "preflight:acme/api",
    "preflight:acme/worker",
    "deliver:acme/api",
    "deliver:acme/worker",
    "finalize",
  ]);
});

test("a recorded propose_pr replay cannot auto-resolve merged PRs while its session can resume", async () => {
  const proposal = proposals[0];
  assert.ok(proposal);
  let resolutionCalls = 0;
  const dependencies = {
    async finalizeFulfilledAgentPullRequestBatches() {
      return 0;
    },
    async resolveIncidentIfAllAgentPullRequestsMerged() {
      resolutionCalls += 1;
      return {
        disposition: "resolved" as const,
        resolved: true as const,
        resolvedIssueCount: 1,
      };
    },
    async preflightProposedPullRequest() {
      return {
        ok: true as const,
        prepared: {
          kind: "recorded" as const,
          delivery: {
            repoFullName: proposal.repoFullName,
            requestedBranchName: proposal.branchName,
            branchName: proposal.branchName,
            url: "https://github.com/acme/api/pull/12",
            prNumber: 12,
            updatedExisting: false,
            headSha: "abc123",
          },
        },
      };
    },
    async deliverProposedPullRequest() {
      return {
        ok: true as const,
        url: "https://github.com/acme/api/pull/12",
        prNumber: 12,
        branchName: proposal.branchName,
        updatedExisting: false,
      };
    },
  };
  const execute = createOutcomeActionExecutor(
    receiptContext,
    "session-1",
    noReceiptLock,
    dependencies,
  );

  const result = await execute({
    toolUseId: "proposal-tool-recorded-merged-replay",
    name: "propose_pr",
    input: { pullRequests: [proposal] },
    hasFindings: true,
    findings: { summary: "The delivered fix merged before its acknowledgement was saved." },
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, true);
  assert.equal(resolutionCalls, 0);
});

test("a post-delivery batch finalization failure defers the acknowledgement", async () => {
  const calls: string[] = [];
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async reserveAgentPullRequestBatch() {
      calls.push("reserve");
      return true;
    },
    async finalizeFulfilledAgentPullRequestBatches() {
      calls.push("finalize");
      throw new Error("database temporarily unavailable");
    },
    async preflightProposedPullRequest(_ctx, proposal) {
      calls.push(`preflight:${proposal.repoFullName}`);
      return { ok: true, prepared: { kind: "patch" as const, patch: "diff" } };
    },
    async deliverProposedPullRequest(_ctx, proposal) {
      calls.push(`deliver:${proposal.repoFullName}`);
      return {
        ok: true,
        url: `https://github.com/${proposal.repoFullName}/pull/12`,
        prNumber: 12,
        branchName: proposal.branchName,
        updatedExisting: false,
      };
    },
  });

  const result = await execute({
    toolUseId: "proposal-tool-finalize-retry",
    name: "propose_pr",
    input: { pullRequests: proposals },
    hasFindings: true,
    findings: { summary: "Both fixes need durable reconciliation." },
  });

  assert.deepEqual(result, { handled: true, deferAck: true });
  assert.deepEqual(calls, [
    "preflight:acme/api",
    "preflight:acme/worker",
    "reserve",
    "deliver:acme/api",
    "deliver:acme/worker",
    "finalize",
  ]);
});

test("a pending delivery recovery keeps the same delivery identity unacknowledged", async () => {
  const proposal = proposals[0];
  assert.ok(proposal);
  const deliveryIds: string[] = [];
  let savedReceipts = 0;
  let finalizationCalls = 0;
  const receiptLock: OutcomeActionReceiptLock = {
    async exclusive(_args, task) {
      return task({
        async load() {
          return null;
        },
        async save() {
          savedReceipts += 1;
        },
      });
    },
  };
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", receiptLock, {
    async finalizeFulfilledAgentPullRequestBatches() {
      finalizationCalls += 1;
      return 0;
    },
    async preflightProposedPullRequest() {
      return { ok: true, prepared: { kind: "patch" as const, patch: "diff" } };
    },
    async deliverProposedPullRequest(_ctx, _proposal, _sessionId, _findings, _prepared, identity) {
      assert.ok(identity);
      deliveryIds.push(identity.deliveryId);
      throw new PullRequestDeliveryRecoveryPendingError("durable recovery read unavailable");
    },
  });
  const call = {
    toolUseId: "proposal-tool-recovery-pending",
    name: "propose_pr" as const,
    input: { pullRequests: [proposal] },
    hasFindings: true,
    findings: { summary: "The canonical delivery outcome is still being recovered." },
  };

  assert.deepEqual(await execute(call), { handled: true, deferAck: true });
  assert.deepEqual(await execute(call), { handled: true, deferAck: true });
  assert.equal(finalizationCalls, 0);
  assert.equal(savedReceipts, 0);
  assert.equal(deliveryIds.length, 2);
  assert.equal(deliveryIds[1], deliveryIds[0]);
});

test("a stale delivery receipt conflict is acknowledged as manual instead of retried", async () => {
  const proposal = proposals[0];
  assert.ok(proposal);
  let deliveryCalls = 0;
  let savedReceipts = 0;
  const receiptLock: OutcomeActionReceiptLock = {
    async exclusive(_args, task) {
      return task({
        async load() {
          return null;
        },
        async save() {
          savedReceipts += 1;
        },
      });
    },
  };
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", receiptLock, {
    async preflightProposedPullRequest() {
      throw new PullRequestDeliveryReceiptConflictError(
        "a closed pull request cannot be replayed as delivered",
      );
    },
    async deliverProposedPullRequest() {
      deliveryCalls += 1;
      throw new Error("delivery must not run for a stale receipt");
    },
  });

  const result = await execute({
    toolUseId: "proposal-tool-stale-receipt",
    name: "propose_pr",
    input: { pullRequests: [proposal] },
    hasFindings: true,
    findings: { summary: "The prior delivery receipt points at a closed pull request." },
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) {
    assert.fail("a receipt invariant must be acknowledged instead of deferred");
  }
  assert.equal(result.ok, false);
  const errors = result.payload.errors;
  assert.ok(Array.isArray(errors));
  assert.match(errors.join(" "), /manual reconciliation/i);
  assert.match(errors.join(" "), /do not retry/i);
  assert.equal(deliveryCalls, 0);
  assert.equal(savedReceipts, 1);
});

test("a single-repository retry repeats batch finalization after a transient failure", async () => {
  const proposal = proposals[0];
  assert.ok(proposal);
  let finalizeCalls = 0;
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async finalizeFulfilledAgentPullRequestBatches() {
      finalizeCalls += 1;
      if (finalizeCalls === 1) throw new Error("batch finalization interrupted");
      return 0;
    },
    async preflightProposedPullRequest() {
      return { ok: true, prepared: { kind: "patch" as const, patch: "diff" } };
    },
    async deliverProposedPullRequest() {
      return {
        ok: true,
        url: "https://github.com/acme/api/pull/12",
        prNumber: 12,
        branchName: proposal.branchName,
        updatedExisting: false,
      };
    },
  });
  const call = {
    toolUseId: "proposal-tool-single-retry",
    name: "propose_pr" as const,
    input: { pullRequests: [proposal] },
    hasFindings: true,
    findings: { summary: "The final repository fix was delivered." },
  };

  assert.deepEqual(await execute(call), { handled: true, deferAck: true });
  const replay = await execute(call);

  assert.equal(replay.handled, true);
  if (!replay.handled || replay.deferAck) return;
  assert.equal(replay.ok, true);
  assert.equal(finalizeCalls, 2);
});

test("a failed single-repository delivery cannot resolve from older merged PRs", async () => {
  const proposal = proposals[0];
  assert.ok(proposal);
  const execute = createOutcomeActionExecutor(receiptContext, "session-1", noReceiptLock, {
    async finalizeFulfilledAgentPullRequestBatches() {
      return 0;
    },
    async preflightProposedPullRequest() {
      return { ok: true, prepared: { kind: "patch" as const, patch: "diff" } };
    },
    async deliverProposedPullRequest() {
      return { ok: false, error: "GitHub rejected the patch" };
    },
  });

  const result = await execute({
    toolUseId: "proposal-tool-single-failure",
    name: "propose_pr",
    input: { pullRequests: [proposal] },
    hasFindings: true,
    findings: { summary: "A second fix is still required." },
  });

  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, false);
});
