import "dotenv/config";
import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, createIncidentLifecycle, db, runMigrations, schema } from "@superlog/db";
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

  const issue = await db.query.issues.findFirst({
    where: eq(schema.issues.id, fixture.issueId),
  });
  assert.equal(issue?.status, "resolved");

  const agentRun = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.id, fixture.agentRunId),
  });
  assert.equal(agentRun?.state, "complete");

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
  const sparseDuplicate = await postGithub(app, "pull_request", `gh-${fixture.tag}-merged-sparse`, {
    action: "closed",
    repository: { full_name: fixture.repoFullName },
    pull_request: { number: fixture.prNumber, merged: true },
    sender: { login: "alice", id: 100 },
    installation: { id: fixture.installationId },
  });
  assert.equal(sparseDuplicate.status, 200);

  const resolvedEventsAfterDuplicate = await db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, fixture.agentRunId),
      eq(schema.incidentEvents.kind, "incident_resolved"),
    ),
  });
  assert.equal(resolvedEventsAfterDuplicate.length, 1);
  const prAfterDuplicate = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.equal(prAfterDuplicate?.mergedByLogin, "alice");
  assert.equal(prAfterDuplicate?.mergedAt?.toISOString(), mergedAt);
  assert.equal(prAfterDuplicate?.closedAt?.toISOString(), mergedAt);
});

test("a merged webhook redelivery cannot resolve a manually reopened incident again", async () => {
  const fixture = await seedAgentPrFixture("merged-redelivery-after-reopen");
  const app = new Hono();
  mountGithubPublic(app);

  const mergedAt = new Date();
  const payload = {
    action: "closed",
    repository: { full_name: fixture.repoFullName },
    pull_request: {
      number: fixture.prNumber,
      merged: true,
      updated_at: mergedAt.toISOString(),
      merged_at: mergedAt.toISOString(),
      closed_at: mergedAt.toISOString(),
      merged_by: { login: "alice", id: 100 },
      head: { sha: "cafebabe", ref: fixture.branchName },
    },
    sender: { login: "alice", id: 100 },
    installation: { id: fixture.installationId },
  };

  assert.equal(
    (await postGithub(app, "pull_request", `gh-${fixture.tag}-merged-first`, payload)).status,
    200,
  );
  const resolved = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, fixture.incidentId),
  });
  assert.equal(resolved?.status, "resolved");
  assert.ok(resolved);

  const reopen = await createIncidentLifecycle(db).reopenManually({
    incident: resolved,
    actor: {},
    reopenedAt: new Date(mergedAt.getTime() + 1_000),
  });
  assert.deepEqual(reopen, { reopened: true });

  assert.equal(
    (await postGithub(app, "pull_request", `gh-${fixture.tag}-merged-redelivery`, payload)).status,
    200,
  );
  const afterRedelivery = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, fixture.incidentId),
  });
  assert.equal(afterRedelivery?.status, "open");
  assert.equal(afterRedelivery?.resolvedAt, null);
});

test("merged agent PR leaves the Incident open while a sibling PR remains open", async () => {
  const fixture = await seedAgentPrFixture("merged-with-open-sibling");
  const primaryPr = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.ok(primaryPr);
  const siblingNumber = fixture.prNumber + 1;
  await db.insert(schema.agentPullRequests).values({
    incidentId: fixture.incidentId,
    agentRunId: fixture.agentRunId,
    installationId: primaryPr.installationId,
    repoFullName: `${fixture.repoFullName}-worker`,
    prNumber: siblingNumber,
    prNodeId: `PR_${fixture.tag}_sibling`,
    url: `https://github.com/${fixture.repoFullName}-worker/pull/${siblingNumber}`,
    branchName: `${fixture.branchName}-worker`,
    baseBranch: "main",
    state: "open",
  });
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
      head: { sha: "cafebabe", ref: fixture.branchName },
    },
    sender: { login: "alice", id: 100 },
    installation: { id: fixture.installationId },
  });

  assert.equal(res.status, 200);
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, fixture.incidentId),
  });
  assert.equal(incident?.status, "open");
  const pullRequests = await db.query.agentPullRequests.findMany({
    where: eq(schema.agentPullRequests.incidentId, fixture.incidentId),
    columns: { state: true },
  });
  assert.deepEqual(pullRequests.map((pr) => pr.state).sort(), ["merged", "open"]);
  const resolvedEvent = await db.query.incidentEvents.findFirst({
    where: and(
      eq(schema.incidentEvents.agentRunId, fixture.agentRunId),
      eq(schema.incidentEvents.kind, "incident_resolved"),
    ),
  });
  assert.equal(resolvedEvent, undefined);
});

test("delayed close and reopen webhooks cannot regress an already merged agent PR", async () => {
  const fixture = await seedAgentPrFixture("merged-monotonic");
  const app = new Hono();
  mountGithubPublic(app);
  const mergedAt = new Date().toISOString();
  const delayedAt = new Date(new Date(mergedAt).getTime() - 1_000).toISOString();

  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-merged`, {
        action: "closed",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: true,
          updated_at: mergedAt,
          merged_at: mergedAt,
          closed_at: mergedAt,
          merged_by: { login: "alice", id: 100 },
        },
        sender: { login: "alice", id: 100 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-late-close`, {
        action: "closed",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: delayedAt,
          closed_at: new Date().toISOString(),
        },
        sender: { login: "bob", id: 101 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-late-reopen`, {
        action: "reopened",
        repository: { full_name: fixture.repoFullName },
        pull_request: { number: fixture.prNumber, merged: false, updated_at: delayedAt },
        sender: { login: "bob", id: 101 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );

  const pullRequest = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.equal(pullRequest?.state, "merged");
  assert.equal(pullRequest?.mergedByLogin, "alice");
  assert.equal(pullRequest?.mergedAt?.toISOString(), mergedAt);
});

test("a stale close cannot override a newer reopened observation", async () => {
  const fixture = await seedAgentPrFixture("stale-close-after-reopen");
  const app = new Hono();
  mountGithubPublic(app);
  const staleClosedAt = new Date(Date.now() + 1_000);
  const reopenedAt = new Date(staleClosedAt.getTime() + 1_000);

  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-reopened`, {
        action: "reopened",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: reopenedAt.toISOString(),
          title: "Fresh title from the reopened observation",
          head: { sha: "fresh-reopened-head", ref: fixture.branchName },
        },
        sender: { login: "alice", id: 100 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-stale-close`, {
        action: "closed",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: staleClosedAt.toISOString(),
          closed_at: staleClosedAt.toISOString(),
          title: "Stale close title",
          head: { sha: "stale-close-head", ref: fixture.branchName },
        },
        sender: { login: "bob", id: 101 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );

  const pullRequest = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.equal(pullRequest?.state, "open");
  assert.equal(pullRequest?.providerUpdatedAt?.toISOString(), reopenedAt.toISOString());
  assert.equal(pullRequest?.title, "Fresh title from the reopened observation");
  assert.equal(pullRequest?.headSha, "fresh-reopened-head");
  assert.equal(pullRequest?.closedAt, null);
});

test("a stale reopen cannot override a newer closed observation", async () => {
  const fixture = await seedAgentPrFixture("stale-reopen-after-close");
  const app = new Hono();
  mountGithubPublic(app);
  const staleReopenedAt = new Date(Date.now() + 1_000);
  const closedAt = new Date(staleReopenedAt.getTime() + 1_000);

  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-closed`, {
        action: "closed",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: closedAt.toISOString(),
          closed_at: closedAt.toISOString(),
          title: "Fresh title from the closed observation",
          head: { sha: "fresh-closed-head", ref: fixture.branchName },
        },
        sender: { login: "alice", id: 100 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-stale-reopen`, {
        action: "reopened",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: staleReopenedAt.toISOString(),
          title: "Stale reopen title",
          head: { sha: "stale-reopen-head", ref: fixture.branchName },
        },
        sender: { login: "bob", id: 101 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );

  const pullRequest = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.equal(pullRequest?.state, "closed");
  assert.equal(pullRequest?.providerUpdatedAt?.toISOString(), closedAt.toISOString());
  assert.equal(pullRequest?.title, "Fresh title from the closed observation");
  assert.equal(pullRequest?.headSha, "fresh-closed-head");
  assert.equal(pullRequest?.closedAt?.toISOString(), closedAt.toISOString());
});

test("stale PR metadata cannot lower the watermark and admit an older close", async () => {
  const fixture = await seedAgentPrFixture("stale-metadata-before-close");
  const app = new Hono();
  mountGithubPublic(app);
  const staleMetadataAt = new Date(Date.now() + 1_000);
  const staleClosedAt = new Date(staleMetadataAt.getTime() + 1_000);
  const reopenedAt = new Date(staleClosedAt.getTime() + 1_000);

  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-reopened`, {
        action: "reopened",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: reopenedAt.toISOString(),
          title: "Fresh title from the latest observation",
          head: { sha: "fresh-latest-head", ref: fixture.branchName },
        },
        sender: { login: "alice", id: 100 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-stale-metadata`, {
        action: "synchronize",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: staleMetadataAt.toISOString(),
          title: "Stale metadata title",
          head: { sha: "stale-metadata-head", ref: fixture.branchName },
        },
        sender: { login: "bob", id: 101 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-stale-close`, {
        action: "closed",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: staleClosedAt.toISOString(),
          closed_at: staleClosedAt.toISOString(),
          title: "Older close title",
          head: { sha: "older-close-head", ref: fixture.branchName },
        },
        sender: { login: "carol", id: 102 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );

  const pullRequest = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.equal(pullRequest?.state, "open");
  assert.equal(pullRequest?.providerUpdatedAt?.toISOString(), reopenedAt.toISOString());
  assert.equal(pullRequest?.title, "Fresh title from the latest observation");
  assert.equal(pullRequest?.headSha, "fresh-latest-head");
  assert.equal(pullRequest?.closedAt, null);
});

test("a delivery without provider time cannot block a later GitHub state observation", async () => {
  const fixture = await seedAgentPrFixture("missing-provider-time");
  const app = new Hono();
  mountGithubPublic(app);
  const providerClosedAt = new Date(Date.now() - 60_000);

  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-metadata`, {
        action: "synchronize",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          title: "Metadata without provider time",
          head: { sha: "metadata-head", ref: fixture.branchName },
        },
        sender: { login: "alice", id: 100 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await postGithub(app, "pull_request", `gh-${fixture.tag}-closed`, {
        action: "closed",
        repository: { full_name: fixture.repoFullName },
        pull_request: {
          number: fixture.prNumber,
          merged: false,
          updated_at: providerClosedAt.toISOString(),
          closed_at: providerClosedAt.toISOString(),
          title: "Closed by the provider",
          head: { sha: "closed-head", ref: fixture.branchName },
        },
        sender: { login: "bob", id: 101 },
        installation: { id: fixture.installationId },
      })
    ).status,
    200,
  );

  const pullRequest = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.id, fixture.agentPrId),
  });
  assert.equal(pullRequest?.state, "closed");
  assert.equal(pullRequest?.providerUpdatedAt?.toISOString(), providerClosedAt.toISOString());
  assert.equal(pullRequest?.title, "Closed by the provider");
  assert.equal(pullRequest?.headSha, "closed-head");
});

test("merged agent PR reaches a surviving session once and does not auto-resolve on redelivery", async () => {
  const fixture = await seedAgentPrFixture("merged-live-session");
  await db
    .update(schema.agentRuns)
    .set({ state: "awaiting_events", providerSessionId: `session-${fixture.tag}` })
    .where(eq(schema.agentRuns.id, fixture.agentRunId));
  const app = new Hono();
  mountGithubPublic(app);

  const mergedAt = new Date().toISOString();
  const delivery = `gh-${fixture.tag}-merged`;
  const payload = {
    action: "closed",
    repository: { full_name: fixture.repoFullName },
    pull_request: {
      number: fixture.prNumber,
      merged: true,
      merged_at: mergedAt,
      closed_at: mergedAt,
      merged_by: { login: "alice", id: 100 },
      head: { sha: "cafebabe", ref: fixture.branchName },
    },
    sender: { login: "alice", id: 100 },
    installation: { id: fixture.installationId },
  };

  assert.equal((await postGithub(app, "pull_request", delivery, payload)).status, 200);
  assert.equal((await postGithub(app, "pull_request", delivery, payload)).status, 200);

  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, fixture.incidentId),
  });
  assert.equal(incident?.status, "open");
  const continuationEvents = await db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, fixture.agentRunId),
      eq(schema.incidentEvents.kind, "human_reply"),
    ),
  });
  assert.equal(continuationEvents.length, 1);
  const resolvedEvent = await db.query.incidentEvents.findFirst({
    where: and(
      eq(schema.incidentEvents.incidentId, fixture.incidentId),
      eq(schema.incidentEvents.kind, "incident_resolved"),
    ),
  });
  assert.equal(resolvedEvent, undefined);
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
      updated_at: closedAt,
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

  const issue = await db.query.issues.findFirst({
    where: eq(schema.issues.id, fixture.issueId),
  });
  assert.equal(issue?.status, "open");

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
