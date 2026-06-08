import "dotenv/config";
import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountGithubPublic } from "./github.js";

const GH_WEBHOOK_SECRET = "github-test-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = GH_WEBHOOK_SECRET;

const orgIds: string[] = [];

before(async () => {
  await runMigrations();
});

after(async () => {
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
  } finally {
    await closeDb();
  }
});

test("merged agent PR resolves incident, cascades linked issues, and writes timeline events", async () => {
  const fixture = await seedAgentPrFixture("merged");
  const app = new Hono();
  mountGithubPublic(app);

  const mergedAt = new Date().toISOString();
  const res = await postGithub(app, "pull_request", `gh-${fixture.tag}-merged`, {
    action: "closed",
    repository: { full_name: fixture.repoFullName },
    pull_request: {
      number: fixture.prNumber,
      merged: true,
      merged_at: mergedAt,
      closed_at: mergedAt,
      merged_by: { login: "alice", id: 100 },
      user: { login: "superlog-bot", id: 999 },
      head: { sha: "cafebabe", ref: fixture.branchName },
    },
    sender: { login: "alice", id: 100 },
    installation: { id: fixture.installationId },
  });

  assert.equal(res.status, 200);

  const pr = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.equal(pr?.state, "merged");
  assert.equal(pr?.mergedByLogin, "alice");
  assert.ok(pr?.mergedAt);

  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, fixture.incidentId),
  });
  assert.equal(incident?.status, "resolved");
  assert.equal(incident?.resolvedReasonCode, "agent_pr_merged");

  const issue = await db.query.issues.findFirst({
    where: eq(schema.issues.id, fixture.issueId),
  });
  assert.ok(issue);

  const resolvedEvents = await db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, fixture.agentRunId),
      eq(schema.incidentEvents.kind, "incident_resolved"),
    ),
  });
  assert.equal(resolvedEvents.length, 1);
  assert.equal(
    resolvedEvents[0]?.summary,
    `Incident resolved because PR #${fixture.prNumber} was merged.`,
  );
  assert.equal(resolvedEvents[0]?.detail?.kind, "agent_pr_merged");
  assert.equal(resolvedEvents[0]?.detail?.reasonCode, "agent_pr_merged");

  const prMergedEvent = await db.query.agentPrEvents.findFirst({
    where: and(
      eq(schema.agentPrEvents.agentPrId, fixture.agentPrId),
      eq(schema.agentPrEvents.kind, "pr_merged"),
    ),
  });
  assert.ok(prMergedEvent);

  const duplicate = await postGithub(app, "pull_request", `gh-${fixture.tag}-merged`, {
    action: "closed",
    repository: { full_name: fixture.repoFullName },
    pull_request: {
      number: fixture.prNumber,
      merged: true,
      merged_at: mergedAt,
      closed_at: mergedAt,
      merged_by: { login: "alice", id: 100 },
    },
    sender: { login: "alice", id: 100 },
    installation: { id: fixture.installationId },
  });
  assert.equal(duplicate.status, 200);

  const resolvedEventsAfterDuplicate = await db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, fixture.agentRunId),
      eq(schema.incidentEvents.kind, "incident_resolved"),
    ),
  });
  assert.equal(resolvedEventsAfterDuplicate.length, 1);
});

test("closed unmerged agent PR does not resolve incident or linked issue", async () => {
  const fixture = await seedAgentPrFixture("closed");
  const app = new Hono();
  mountGithubPublic(app);

  const closedAt = new Date().toISOString();
  const res = await postGithub(app, "pull_request", `gh-${fixture.tag}-closed`, {
    action: "closed",
    repository: { full_name: fixture.repoFullName },
    pull_request: {
      number: fixture.prNumber,
      merged: false,
      closed_at: closedAt,
      user: { login: "superlog-bot", id: 999 },
    },
    sender: { login: "alice", id: 100 },
    installation: { id: fixture.installationId },
  });

  assert.equal(res.status, 200);

  const pr = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.equal(pr?.state, "closed");

  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, fixture.incidentId),
  });
  assert.equal(incident?.status, "open");
  assert.equal(incident?.resolvedReasonCode, null);

  const issue = await db.query.issues.findFirst({
    where: eq(schema.issues.id, fixture.issueId),
  });
  assert.ok(issue);

  const resolvedEvent = await db.query.incidentEvents.findFirst({
    where: and(
      eq(schema.incidentEvents.agentRunId, fixture.agentRunId),
      eq(schema.incidentEvents.kind, "incident_resolved"),
    ),
  });
  assert.equal(resolvedEvent, undefined);
});

async function seedAgentPrFixture(label: string): Promise<{
  tag: string;
  repoFullName: string;
  branchName: string;
  installationId: number;
  incidentId: string;
  issueId: string;
  agentRunId: string;
  agentPrId: string;
  prNumber: number;
}> {
  const tag = `test-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const repoFullName = `acme/${tag}`;
  const branchName = `superlog/${tag}`;
  const installationId = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1_000_000);
  const prNumber = Math.floor(Math.random() * 10_000) + 1;

  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("failed to seed org");
  orgIds.push(org.id);

  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "test", slug: tag })
    .returning();
  if (!project) throw new Error("failed to seed project");

  const now = new Date();
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: project.id,
      title: "Test incident",
      service: "api",
      firstSeen: now,
      lastSeen: now,
    })
    .returning();
  if (!incident) throw new Error("failed to seed incident");

  const [issue] = await db
    .insert(schema.issues)
    .values({
      projectId: project.id,
      fingerprint: `fp-${tag}`,
      kind: "span",
      service: "api",
      exceptionType: "Error",
      title: "Test issue",
      message: "boom",
      firstSeen: now,
      lastSeen: now,
    })
    .returning();
  if (!issue) throw new Error("failed to seed issue");

  await db.insert(schema.incidentIssues).values({
    incidentId: incident.id,
    issueId: issue.id,
  });

  const [agentRun] = await db
    .insert(schema.agentRuns)
    .values({ incidentId: incident.id, runtime: "anthropic", state: "running" })
    .returning();
  if (!agentRun) throw new Error("failed to seed agent run");

  const [installation] = await db
    .insert(schema.githubInstallations)
    .values({
      orgId: org.id,
      projectId: project.id,
      installationId,
      accountLogin: "acme-bot",
      accountType: "Organization",
      repos: [{ id: 1, fullName: repoFullName, private: false }],
    })
    .returning();
  if (!installation) throw new Error("failed to seed GitHub installation");

  const [agentPr] = await db
    .insert(schema.agentPullRequests)
    .values({
      incidentId: incident.id,
      agentRunId: agentRun.id,
      installationId: installation.id,
      repoFullName,
      prNumber,
      prNodeId: `PR_${tag}`,
      url: `https://github.com/${repoFullName}/pull/${prNumber}`,
      branchName,
      baseBranch: "main",
      headSha: "deadbeef",
      title: "[superlog] Fix bug",
      state: "open",
      lastSyncedAt: now,
    })
    .returning();
  if (!agentPr) throw new Error("failed to seed agent PR");

  return {
    tag,
    repoFullName,
    branchName,
    installationId,
    incidentId: incident.id,
    issueId: issue.id,
    agentRunId: agentRun.id,
    agentPrId: agentPr.id,
    prNumber,
  };
}

async function postGithub(
  app: Hono,
  event: string,
  delivery: string,
  payload: unknown,
): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request("/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": ghSign(body),
    },
    body,
  });
}

function ghSign(body: string): string {
  return `sha256=${crypto.createHmac("sha256", GH_WEBHOOK_SECRET).update(body).digest("hex")}`;
}
