import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  AGENT_PULL_REQUEST_REVIEW_CONTINUATION_LIMIT,
  closeDb,
  db,
  runMigrations,
  schema,
} from "@superlog/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentRunContext, InstalledGithubRepo } from "../../worker/src/agent-run-context.js";
import { deliverProposedPullRequest } from "../../worker/src/agent-runs/pr-delivery.js";
import { resumeDurableAgentRun } from "../../worker/src/agent-runs/resume.js";
import { mountGithubPublic } from "../src/github.js";

// Exercise the real webhook, durable-resume, persistence, and delivery orchestration
// against an isolated local fixture. Provider and GitHub writes stay behind fakes.
const webhookSecret = "agent-pr-review-loop-drill";
process.env.GITHUB_APP_WEBHOOK_SECRET = webhookSecret;
process.env.GITHUB_APP_SLUG = "superlog-app";

const tag = `review-loop-drill-${Date.now()}-${crypto.randomUUID()}`;
const repoFullName = `acme/${tag}`;
const branchName = `ash/${tag}`;
const prNumber = crypto.randomInt(1, 10_001);
const installationId = Math.floor(Date.now() / 1_000) + crypto.randomInt(1_000_000);
const providerMessages: string[] = [];
const pushedUpdates: Array<{ prNumber: number; branchName: string; commentBody: string }> = [];
const limitComments: string[] = [];

await runMigrations();

const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
if (!org) throw new Error("failed to seed drill organization");

try {
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Review loop drill", slug: tag })
    .returning();
  if (!project) throw new Error("failed to seed drill project");

  const now = new Date();
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: project.id,
      title: "Review loop drill incident",
      service: "api",
      firstSeen: now,
      lastSeen: now,
    })
    .returning();
  if (!incident) throw new Error("failed to seed drill incident");

  const [agentRun] = await db
    .insert(schema.agentRuns)
    .values({
      incidentId: incident.id,
      runtime: "anthropic",
      state: "awaiting_events",
      providerSessionId: `session-${tag}`,
    })
    .returning();
  if (!agentRun) throw new Error("failed to seed drill agent run");

  const [installation] = await db
    .insert(schema.githubInstallations)
    .values({
      orgId: org.id,
      projectId: project.id,
      installationId,
      accountLogin: "acme",
      accountType: "Organization",
      repos: [{ id: 123, fullName: repoFullName, private: false }],
    })
    .returning();
  if (!installation) throw new Error("failed to seed drill GitHub installation");

  const [agentPr] = await db
    .insert(schema.agentPullRequests)
    .values({
      incidentId: incident.id,
      agentRunId: agentRun.id,
      installationId: installation.id,
      repoFullName,
      prNumber,
      prNodeId: `PR_${tag}`,
      url: `https://github.test/${repoFullName}/pull/${prNumber}`,
      branchName,
      baseBranch: "main",
      headSha: "initial-head",
      title: "[superlog] Review loop drill",
      state: "open",
      lastSyncedAt: now,
    })
    .returning();
  if (!agentPr) throw new Error("failed to seed drill pull request");

  const app = new Hono();
  mountGithubPublic(app, {
    async postAgentPrComment({ body }) {
      limitComments.push(body);
      return { ok: true };
    },
  });

  const repo: InstalledGithubRepo = {
    id: 123,
    fullName: repoFullName,
    private: false,
    installation,
  };

  const runIteration = async (reviewId: number, reviewBody: string, headSha: string) => {
    const response = await postReview(app, {
      delivery: `${tag}-review-${reviewId}`,
      reviewId,
      body: reviewBody,
      repoFullName,
      branchName,
      prNumber,
      installationId,
      actor: "reviewer[bot]",
    });
    assert.equal(response.status, 200);

    const inputs = await db.query.incidentEvents.findMany({
      where: and(
        eq(schema.incidentEvents.agentRunId, agentRun.id),
        eq(schema.incidentEvents.kind, "github_comment"),
        isNull(schema.incidentEvents.processedAt),
      ),
    });
    assert.equal(inputs.length, 1, "each accepted review should create one resumable input");

    const resumed = await resumeDurableAgentRun({
      sessionId: agentRun.providerSessionId ?? "",
      inputs,
      runner: {
        async resume(sessionId, message) {
          assert.equal(sessionId, agentRun.providerSessionId);
          providerMessages.push(message);
        },
        async steer() {
          throw new Error("review feedback must resume, not steer, the provider session");
        },
      },
      async transitionToRunning() {
        const rows = await db
          .update(schema.agentRuns)
          .set({ state: "running" })
          .where(eq(schema.agentRuns.id, agentRun.id))
          .returning({ id: schema.agentRuns.id });
        return rows.length === 1;
      },
      async markProcessed(ids) {
        await db
          .update(schema.incidentEvents)
          .set({ processedAt: new Date() })
          .where(inArray(schema.incidentEvents.id, ids));
      },
    });
    assert.equal(resumed, "resumed");
    assert.match(providerMessages.at(-1) ?? "", new RegExp(escapeRegExp(reviewBody)));

    const currentRun = await db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, agentRun.id),
    });
    assert.ok(currentRun);
    const ctx = {
      agentRun: currentRun,
      incident,
      org,
      project,
      automation: {
        autoInvestigateIssuesEnabled: true,
        agentRunProvider: "anthropic",
        maxRuntimeMinutes: 30,
        maxHumanResumeCount: 3,
      },
      githubInstalls: [{ installation, allowedRepoIds: null }],
      linearInstall: null,
      customInstructions: "",
      linearTicketPolicy: "never",
      linearTicketInstructions: [],
      linearDefaultTeamId: null,
      prPolicy: "always",
      approvalPromptsEnabled: false,
      createLinearTicketOnResolve: false,
      prBaseBranch: "main",
      autoMergeFixPrs: "never",
      autoMergeMethod: "squash",
      issueRows: [],
      memories: [],
      followUp: null,
      predecessors: [],
    } as AgentRunContext;

    const delivery = await deliverProposedPullRequest(
      ctx,
      {
        repoFullName,
        title: `Address review ${reviewId}`,
        body: `Addressed: ${reviewBody}`,
        branchName,
        baseBranch: "main",
        patchFilePath: `/tmp/${tag}-${reviewId}.patch`,
      },
      agentRun.providerSessionId ?? "",
      { summary: `Addressed review ${reviewId}` },
      { kind: "patch", patch: `diff --git a/review-${reviewId} b/review-${reviewId}` },
      {
        deliveryId: `review-${reviewId}-${tag}`,
        inputHash: `review-${reviewId}-input`,
        requestedBranchName: branchName,
      },
      {
        listRepositories: async () => [repo],
        pushPatchToExistingPr: async (input) => {
          pushedUpdates.push({
            prNumber: input.prNumber,
            branchName: input.branchName,
            commentBody: input.commentBody,
          });
          return { headSha };
        },
      },
    );
    assert.deepEqual(delivery, {
      ok: true,
      url: agentPr.url,
      prNumber,
      branchName,
      updatedExisting: true,
    });

    const updatedPr = await db.query.agentPullRequests.findFirst({
      where: eq(schema.agentPullRequests.id, agentPr.id),
    });
    assert.equal(updatedPr?.headSha, headSha);
  };

  await runIteration(
    1,
    "Return a discriminated failure value instead of throwing.",
    "review-head-1",
  );

  await db
    .update(schema.agentRuns)
    .set({ state: "awaiting_events" })
    .where(eq(schema.agentRuns.id, agentRun.id));
  await db.insert(schema.agentPrEvents).values(
    Array.from({ length: AGENT_PULL_REQUEST_REVIEW_CONTINUATION_LIMIT - 2 }, (_, index) => ({
      agentPrId: agentPr.id,
      kind: "review_comment" as const,
      summary: "Prior review interaction",
      actorLogin: "reviewer[bot]",
      providerEventId: `${tag}-prior-${index}`,
      occurredAt: new Date(Date.now() - (index + 1) * 1_000),
    })),
  );

  await runIteration(100, "Add a regression test for the failure result.", "review-head-100");

  const blockedReviewIds = Array.from({ length: 50 }, (_, index) => 101 + index);
  const blockedResponses = await Promise.all(
    blockedReviewIds.map((reviewId) =>
      postReview(app, {
        delivery: `${tag}-review-${reviewId}`,
        reviewId,
        body: `Over-limit review ${reviewId}`,
        repoFullName,
        branchName,
        prNumber,
        installationId,
        actor: "reviewer[bot]",
      }),
    ),
  );
  assert.ok(blockedResponses.every((response) => response.status === 200));

  const ownComment = await postIssueComment(app, {
    delivery: `${tag}-own-comment`,
    body: "I pushed updates addressing the review.",
    repoFullName,
    prNumber,
    installationId,
    actor: "superlog-app[bot]",
  });
  assert.equal(ownComment.status, 200);

  const unprocessedInputs = await db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, agentRun.id),
      eq(schema.incidentEvents.kind, "github_comment"),
      isNull(schema.incidentEvents.processedAt),
    ),
  });
  assert.equal(unprocessedInputs.length, 0, "over-limit and own comments must not resume the run");
  assert.equal(providerMessages.length, 2);
  assert.equal(pushedUpdates.length, 2);
  assert.ok(pushedUpdates.every((update) => update.prNumber === prNumber));
  assert.ok(pushedUpdates.every((update) => update.branchName === branchName));
  assert.equal(limitComments.length, 1);
  assert.match(limitComments[0] ?? "", /100 PR review comments/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        acceptedReviewResumes: providerMessages.length,
        existingPullRequestUpdates: pushedUpdates.length,
        pullRequestNumber: prNumber,
        branchName,
        limitComments: limitComments.length,
        concurrentBlockedReviews: blockedReviewIds.length,
        ownBotCommentsIgnored: 1,
      },
      null,
      2,
    ),
  );
} finally {
  await db.delete(schema.orgs).where(eq(schema.orgs.id, org.id));
  await closeDb();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function postReview(
  app: Hono,
  opts: {
    delivery: string;
    reviewId: number;
    body: string;
    repoFullName: string;
    branchName: string;
    prNumber: number;
    installationId: number;
    actor: string;
  },
): Promise<Response> {
  return postGithub(app, "pull_request_review", opts.delivery, {
    action: "submitted",
    repository: { full_name: opts.repoFullName },
    pull_request: {
      number: opts.prNumber,
      head: { sha: "provider-head", ref: opts.branchName },
    },
    review: {
      id: opts.reviewId,
      state: "changes_requested",
      body: opts.body,
      html_url: `https://github.test/${opts.repoFullName}/pull/${opts.prNumber}#review-${opts.reviewId}`,
      author_association: "NONE",
      user: { login: opts.actor, id: 501, type: "Bot" },
    },
    sender: { login: opts.actor, id: 501, type: "Bot" },
    installation: { id: opts.installationId },
  });
}

async function postIssueComment(
  app: Hono,
  opts: {
    delivery: string;
    body: string;
    repoFullName: string;
    prNumber: number;
    installationId: number;
    actor: string;
  },
): Promise<Response> {
  return postGithub(app, "issue_comment", opts.delivery, {
    action: "created",
    repository: { full_name: opts.repoFullName },
    issue: { number: opts.prNumber, pull_request: { url: "https://api.github.test/pull" } },
    comment: {
      id: 999,
      body: opts.body,
      html_url: `https://github.test/${opts.repoFullName}/pull/${opts.prNumber}#own-comment`,
      author_association: "NONE",
      user: { login: opts.actor, id: 601, type: "Bot" },
    },
    sender: { login: opts.actor, id: 601, type: "Bot" },
    installation: { id: opts.installationId },
  });
}

async function postGithub(
  app: Hono,
  event: string,
  delivery: string,
  payload: unknown,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
  return app.request("/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}
