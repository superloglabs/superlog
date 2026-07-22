import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  buildFollowUpContext,
  effectivePrPolicyForAgentRun,
  listAccessibleGithubRepositories,
} from "./agent-run-context.js";
import { buildAgentRunInstructions } from "./agent-run-instructions.js";

test("agent run instructions include org guidance, project context, and project instructions", () => {
  const instructions = buildAgentRunInstructions({
    orgInstructions: "Prefer small patches.",
    projectContext: "This project is the billing API. Stripe IDs are customer-scoped.",
    projectInstructions: "Run billing tests before opening a PR.",
  });

  assert.equal(
    instructions,
    [
      "Prefer small patches.",
      "Project context:\nThis project is the billing API. Stripe IDs are customer-scoped.",
      "Run billing tests before opening a PR.",
    ].join("\n\n"),
  );
});

test("buildFollowUpContext returns null for ordinary incident-triggered runs", () => {
  const followUp = buildFollowUpContext({
    trigger: "incident",
    triggerDetail: null,
    priorRun: null,
    events: [],
  });
  assert.equal(followUp, null);
});

test("buildFollowUpContext carries prior findings, handoff notes, PR, and timeline", () => {
  const priorRun = {
    state: "complete",
    selectedRepoFullName: "acme/api",
    result: {
      state: "complete",
      summary: "Fixed the checkout NPE.",
      rootCause: { text: "Null cart in retry path.", confidence: 8 },
      handoffNotes: "Examined cart.ts and retry.ts; ruled out the queue (idempotent).",
      pr: {
        branchName: "superlog/fix-cart-npe",
        url: "https://github.com/acme/api/pull/12",
        validationSummary: "pnpm test passed (212 tests).",
      },
    },
  } as unknown as schema.AgentRun;

  const followUp = buildFollowUpContext({
    trigger: "pr_comment",
    triggerDetail: {
      interactions: [
        {
          channel: "pr_comment",
          author: "alice",
          text: "Please also guard the empty-cart case.",
          url: "https://github.com/acme/api/pull/12#discussion_r1",
          path: "src/cart.ts",
          line: 42,
          occurredAt: "2026-06-10T12:00:00Z",
        },
      ],
      pullRequests: [
        {
          agentPrId: "agent-pr-12",
          repoFullName: "acme/api",
          prNumber: 12,
          url: "https://github.com/acme/api/pull/12",
          branchName: "superlog/fix-cart-npe",
          baseBranch: "main",
          state: "open",
        },
        {
          agentPrId: "agent-pr-19",
          repoFullName: "acme/worker",
          prNumber: 19,
          url: "https://github.com/acme/worker/pull/19",
          branchName: "superlog/fix-cart-worker",
          baseBranch: "main",
          state: "open",
        },
      ],
    },
    priorRun,
    events: [
      { kind: "agent_run_started", summary: "Investigation started across 2 candidate repos." },
      { kind: "pr_opened", summary: "Opened PR: https://github.com/acme/api/pull/12" },
      { kind: "noise", summary: null },
    ],
  });

  assert.ok(followUp);
  assert.equal(followUp.trigger, "pr_comment");
  assert.equal(followUp.interactions.length, 1);
  assert.equal(followUp.interactions[0]?.path, "src/cart.ts");
  assert.deepEqual(followUp.pullRequests, [
    {
      agentPrId: "agent-pr-12",
      repoFullName: "acme/api",
      prNumber: 12,
      url: "https://github.com/acme/api/pull/12",
      branchName: "superlog/fix-cart-npe",
      baseBranch: "main",
      state: "open",
    },
    {
      agentPrId: "agent-pr-19",
      repoFullName: "acme/worker",
      prNumber: 19,
      url: "https://github.com/acme/worker/pull/19",
      branchName: "superlog/fix-cart-worker",
      baseBranch: "main",
      state: "open",
    },
  ]);
  assert.deepEqual(followUp.priorRun, {
    state: "complete",
    summary: "Fixed the checkout NPE.",
    rootCause: "Null cart in retry path.",
    handoffNotes: "Examined cart.ts and retry.ts; ruled out the queue (idempotent).",
    validationSummary: "pnpm test passed (212 tests).",
    repoFullName: "acme/api",
    prBranch: "superlog/fix-cart-npe",
    prUrl: "https://github.com/acme/api/pull/12",
  });
  assert.deepEqual(followUp.timeline, [
    "agent_run_started: Investigation started across 2 candidate repos.",
    "pr_opened: Opened PR: https://github.com/acme/api/pull/12",
  ]);
});

test("buildFollowUpContext tolerates a missing prior run and empty detail", () => {
  const followUp = buildFollowUpContext({
    trigger: "slack_reply",
    triggerDetail: null,
    priorRun: null,
    events: [],
  });
  assert.ok(followUp);
  assert.equal(followUp.priorRun, null);
  assert.deepEqual(followUp.interactions, []);
  assert.deepEqual(followUp.pullRequests, []);
  assert.deepEqual(followUp.timeline, []);
});

test("only an explicit Slack Open a PR run overrides a do-not-PR project policy", () => {
  assert.equal(effectivePrPolicyForAgentRun("never", "incident"), "never");
  assert.equal(effectivePrPolicyForAgentRun("never", "slack_open_pr"), "on_ready_to_pr");
  assert.equal(effectivePrPolicyForAgentRun("always", "slack_open_pr"), "always");
});

test("agent run instructions skip blank project context", () => {
  const instructions = buildAgentRunInstructions({
    orgInstructions: "Prefer small patches.",
    projectContext: "   ",
    projectInstructions: "Run billing tests before opening a PR.",
  });

  assert.equal(instructions, "Prefer small patches.\n\nRun billing tests before opening a PR.");
});

test("repository discovery surfaces failure when every enabled installation errors", async () => {
  const githubUnavailable = new Error("github returned 503");
  const githubInstalls = [
    {
      installation: {
        installationId: 101,
        agentEnabled: true,
        repoAccess: null,
      } as schema.GithubInstallation,
      allowedRepoIds: null,
    },
    {
      installation: {
        installationId: 202,
        agentEnabled: false,
        repoAccess: null,
      } as schema.GithubInstallation,
      allowedRepoIds: null,
    },
  ];

  await assert.rejects(
    listAccessibleGithubRepositories(
      { githubInstalls },
      {
        listInstallationRepositories: async () => {
          throw githubUnavailable;
        },
      },
    ),
    githubUnavailable,
  );
});

test("repository lookup surfaces a partial failure when successful installs have no usable repos", async () => {
  const githubUnavailable = new Error("github returned 503");
  const githubInstalls = [
    {
      installation: {
        installationId: 101,
        agentEnabled: true,
        repoAccess: { disabledRepoIds: [42] },
      } as schema.GithubInstallation,
      allowedRepoIds: null,
    },
    {
      installation: {
        installationId: 202,
        agentEnabled: true,
        repoAccess: null,
      } as schema.GithubInstallation,
      allowedRepoIds: null,
    },
  ];

  await assert.rejects(
    listAccessibleGithubRepositories(
      { githubInstalls },
      {
        listInstallationRepositories: async (installationId) => {
          if (installationId === 101) {
            return [{ id: 42, fullName: "acme/disabled", private: true }];
          }
          throw githubUnavailable;
        },
      },
    ),
    githubUnavailable,
  );
});

test("repository discovery tolerates a partial failure when another enabled install succeeds", async () => {
  const githubUnavailable = new Error("github returned 503");
  const githubInstalls = [
    {
      installation: {
        installationId: 101,
        agentEnabled: true,
        repoAccess: { disabledRepoIds: [42] },
      } as schema.GithubInstallation,
      allowedRepoIds: null,
    },
    {
      installation: {
        installationId: 202,
        agentEnabled: true,
        repoAccess: null,
      } as schema.GithubInstallation,
      allowedRepoIds: null,
    },
  ];

  const repositories = await listAccessibleGithubRepositories(
    { githubInstalls },
    {
      toleratePartialFailure: true,
      listInstallationRepositories: async (installationId) => {
        if (installationId === 101) {
          return [{ id: 42, fullName: "acme/disabled", private: true }];
        }
        throw githubUnavailable;
      },
    },
  );

  assert.deepEqual(repositories, []);
});
