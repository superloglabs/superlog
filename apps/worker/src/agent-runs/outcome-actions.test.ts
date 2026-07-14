import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequestProposal } from "../agent-outcome-tools.js";
import {
  createOutcomeActionExecutor,
  executeProposedPullRequestBatch,
  missingMobileTestDecision,
} from "./outcome-actions.js";

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
        ok: true,
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
  const execute = createOutcomeActionExecutor({} as never, "session-1");
  const result = await execute({
    name: "silence_as_noise",
    input: { issueId: "issue-1" },
    hasFindings: true,
    findings: null,
  });

  assert.equal(result.handled, true);
  if (!result.handled) return;
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.payload), /resolve_incident\.issueOutcomes/);
});
