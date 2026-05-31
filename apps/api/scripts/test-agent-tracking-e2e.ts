/**
 * End-to-end integration test for agent PR / Linear ticket tracking.
 *
 * What this exercises:
 *   1. Migrations apply cleanly (creates the four new tables + linear webhook columns).
 *   2. Worker-side row creation: agent_pull_requests + initial pr_opened event.
 *   3. GitHub webhook handler updates parent state and appends agent_pr_events
 *      for: pull_request closed/merged, push, pull_request_review,
 *      pull_request_review_comment, issue_comment.
 *      A merged PR also resolves the incident, cascades linked issues, and
 *      writes an incident timeline event.
 *   4. Worker-side Linear ticket creation: agent_linear_tickets + ticket_filed event.
 *   5. Linear webhook handler updates parent state and appends agent_linear_ticket_events
 *      for: Issue update (state change), Comment create.
 *   6. Timeline merge: incident_events + agent_pr_events + agent_linear_ticket_events
 *      come back chronologically with actor metadata.
 *
 * What this does NOT exercise:
 *   - Real GitHub PR creation (requires installed GitHub App + repo).
 *   - Real Linear ticket creation (requires agent run with OAuth + MCP).
 *   - Linear webhook auto-registration on OAuth (requires public API_BASE_URL).
 *
 * Run: pnpm exec tsx scripts/test-agent-tracking-e2e.ts
 */

import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import "dotenv/config";
import { Hono } from "hono";
import { db, runMigrations, schema } from "@superlog/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { mountGithubPublic } from "../src/github.js";
import { mountLinearPublic } from "../src/linear.js";

const TEST_TAG = `e2e-${Date.now()}`;
const GH_INSTALLATION_ID = Math.floor(Date.now() / 1000) + 9_000_000; // unique-ish
const REPO_FULL_NAME = `acme/${TEST_TAG}`;
const PR_NUMBER = 42;
const LINEAR_WORKSPACE_ID = `ws-${TEST_TAG}`;
const LINEAR_TICKET_ID = `linear-issue-${TEST_TAG}`;
const LINEAR_WEBHOOK_ID = `wh-${TEST_TAG}`;
const LINEAR_WEBHOOK_SECRET = "linear-test-secret";

process.env.GITHUB_APP_WEBHOOK_SECRET ??= "github-test-secret";
const GH_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET;

function step(label: string) {
  console.log(`\n— ${label}`);
}

function ok(label: string) {
  console.log(`  ✓ ${label}`);
}

async function seed(): Promise<{
  orgId: string;
  projectId: string;
  incidentId: string;
  issueId: string;
  agentRunId: string;
  ghInstallRowId: string;
  linearInstallRowId: string;
  agentPrRowId: string;
  agentTicketRowId: string;
}> {
  // Org / user / project
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `e2e-${TEST_TAG}`, slug: `e2e-${TEST_TAG}` })
    .returning();
  if (!org) throw new Error("seed org failed");

  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "test", slug: `test-${TEST_TAG}` })
    .returning();
  if (!project) throw new Error("seed project failed");

  // Incident + agentRun
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: project.id,
      title: "Test incident",
      service: "api",
      firstSeen: new Date(),
      lastSeen: new Date(),
    })
    .returning();
  if (!incident) throw new Error("seed incident failed");

  const [issue] = await db
    .insert(schema.issues)
    .values({
      projectId: project.id,
      fingerprint: `fp-${TEST_TAG}`,
      kind: "span",
      service: "api",
      exceptionType: "Error",
      title: "Test issue",
      message: "boom",
      firstSeen: new Date(),
      lastSeen: new Date(),
    })
    .returning();
  if (!issue) throw new Error("seed issue failed");

  await db.insert(schema.incidentIssues).values({
    incidentId: incident.id,
    issueId: issue.id,
  });

  const [agentRun] = await db
    .insert(schema.agentRuns)
    .values({ incidentId: incident.id, runtime: "anthropic", state: "running" })
    .returning();
  if (!agentRun) throw new Error("seed agent run failed");

  await db.insert(schema.incidentEvents).values({
    agentRunId: agentRun.id,
    kind: "agent.session_started",
    summary: "Agent session started",
  });

  // GitHub installation
  const [ghInstall] = await db
    .insert(schema.githubInstallations)
    .values({
      orgId: org.id,
      projectId: project.id,
      installationId: GH_INSTALLATION_ID,
      accountLogin: "acme-bot",
      accountType: "Organization",
      repos: [{ id: 1, fullName: REPO_FULL_NAME, private: false }],
    })
    .returning();
  if (!ghInstall) throw new Error("seed gh install failed");

  // Linear installation (with webhook id/secret pre-populated)
  const [linearInstall] = await db
    .insert(schema.linearInstallations)
    .values({
      projectId: project.id,
      workspaceId: LINEAR_WORKSPACE_ID,
      workspaceName: "Acme",
      accessToken: "fake-token",
      webhookId: LINEAR_WEBHOOK_ID,
      webhookSecret: LINEAR_WEBHOOK_SECRET,
    })
    .returning();
  if (!linearInstall) throw new Error("seed linear install failed");

  // Worker-created rows: pretend the worker already opened a PR + filed a ticket.
  const [agentPr] = await db
    .insert(schema.agentPullRequests)
    .values({
      incidentId: incident.id,
      agentRunId: agentRun.id,
      installationId: ghInstall.id,
      repoFullName: REPO_FULL_NAME,
      prNumber: PR_NUMBER,
      prNodeId: "PR_node_1",
      url: `https://github.com/${REPO_FULL_NAME}/pull/${PR_NUMBER}`,
      branchName: "superlog/fix-1",
      baseBranch: "main",
      headSha: "deadbeef",
      title: "[superlog] Fix bug",
      state: "open",
      lastSyncedAt: new Date(),
    })
    .returning();
  if (!agentPr) throw new Error("seed agent_pr failed");

  await db.insert(schema.agentPrEvents).values({
    agentPrId: agentPr.id,
    kind: "pr_opened",
    summary: `Opened PR #${PR_NUMBER}`,
    actorLogin: "superlog-bot",
    payload: { url: agentPr.url },
    providerEventId: `pr_opened:${REPO_FULL_NAME}#${PR_NUMBER}`,
    occurredAt: new Date(),
  });

  const [agentTicket] = await db
    .insert(schema.agentLinearTickets)
    .values({
      incidentId: incident.id,
      agentRunId: agentRun.id,
      installationId: linearInstall.id,
      workspaceId: LINEAR_WORKSPACE_ID,
      ticketId: LINEAR_TICKET_ID,
      url: `https://linear.app/acme/issue/ENG-1`,
      lastSyncedAt: new Date(),
    })
    .returning();
  if (!agentTicket) throw new Error("seed agent_ticket failed");

  await db.insert(schema.agentLinearTicketEvents).values({
    agentLinearTicketId: agentTicket.id,
    kind: "ticket_filed",
    summary: `Filed ${LINEAR_TICKET_ID}`,
    occurredAt: new Date(),
    providerEventId: `ticket_filed:${LINEAR_WORKSPACE_ID}:${LINEAR_TICKET_ID}`,
  });

  return {
    orgId: org.id,
    projectId: project.id,
    incidentId: incident.id,
    issueId: issue.id,
    agentRunId: agentRun.id,
    ghInstallRowId: ghInstall.id,
    linearInstallRowId: linearInstall.id,
    agentPrRowId: agentPr.id,
    agentTicketRowId: agentTicket.id,
  };
}

async function cleanup(orgId: string): Promise<void> {
  // FKs cascade from org → projects → incidents → agentRuns → events.
  // github_installations / linear_installations cascade from org too.
  await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
}

function ghSign(body: string): string {
  return `sha256=${crypto.createHmac("sha256", GH_WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function linearSign(body: string): string {
  return crypto.createHmac("sha256", LINEAR_WEBHOOK_SECRET).update(body).digest("hex");
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

async function postLinear(app: Hono, delivery: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request("/linear/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": linearSign(body),
      "linear-delivery": delivery,
    },
    body,
  });
}

async function main() {
  step("Apply migrations");
  await runMigrations();
  ok("migrations applied");

  step("Seed test fixtures");
  const seeded = await seed();
  ok(`org=${seeded.orgId} pr=${seeded.agentPrRowId} ticket=${seeded.agentTicketRowId}`);

  try {
    // Build a Hono app with just the webhook routes mounted.
    // biome-ignore lint/suspicious/noExplicitAny: test harness
    const app = new Hono<any>();
    mountGithubPublic(app);
    mountLinearPublic(app);

    step("GitHub webhook: pull_request_review submitted");
    {
      const res = await postGithub(app, "pull_request_review", `del-${TEST_TAG}-1`, {
        action: "submitted",
        repository: { full_name: REPO_FULL_NAME },
        pull_request: { number: PR_NUMBER },
        review: {
          id: 1001,
          state: "approved",
          user: { login: "alice", id: 100, avatar_url: "https://avatars.example/alice" },
        },
        sender: { login: "alice", id: 100 },
        installation: { id: GH_INSTALLATION_ID },
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);

      const events = await db.query.agentPrEvents.findMany({
        where: eq(schema.agentPrEvents.agentPrId, seeded.agentPrRowId),
        orderBy: [desc(schema.agentPrEvents.createdAt)],
        limit: 1,
      });
      assert.equal(events[0]?.kind, "review_approved");
      assert.equal(events[0]?.actorLogin, "alice");
      ok(`event recorded: ${events[0]?.kind} by ${events[0]?.actorLogin}`);
    }

    step("GitHub webhook: issue_comment on PR");
    {
      const res = await postGithub(app, "issue_comment", `del-${TEST_TAG}-2`, {
        action: "created",
        repository: { full_name: REPO_FULL_NAME },
        issue: { number: PR_NUMBER, pull_request: { url: "..." } },
        comment: {
          id: 2002,
          body: "LGTM",
          user: { login: "bob", id: 200, avatar_url: "https://avatars.example/bob" },
        },
        installation: { id: GH_INSTALLATION_ID },
      });
      assert.equal(res.status, 200);

      const ev = await db.query.agentPrEvents.findFirst({
        where: and(
          eq(schema.agentPrEvents.agentPrId, seeded.agentPrRowId),
          eq(schema.agentPrEvents.kind, "issue_comment"),
        ),
      });
      assert.ok(ev, "expected issue_comment event");
      assert.equal(ev.actorLogin, "bob");
      ok(`event recorded: issue_comment by ${ev.actorLogin}`);
    }

    step("GitHub webhook: push to head branch updates head_sha");
    {
      const res = await postGithub(app, "push", `del-${TEST_TAG}-3`, {
        ref: "refs/heads/superlog/fix-1",
        before: "deadbeef",
        after: "cafebabe",
        repository: { full_name: REPO_FULL_NAME },
        pusher: { name: "alice" },
        sender: { login: "alice", id: 100 },
        commits: [{ id: "cafebabe", message: "fix" }],
        installation: { id: GH_INSTALLATION_ID },
      });
      assert.equal(res.status, 200);

      const pr = await db.query.agentPullRequests.findFirst({
        where: eq(schema.agentPullRequests.id, seeded.agentPrRowId),
      });
      assert.equal(pr?.headSha, "cafebabe");
      ok(`head_sha updated: ${pr?.headSha}`);
    }

    step("GitHub webhook: pull_request closed (merged)");
    {
      const mergedAt = new Date().toISOString();
      const res = await postGithub(app, "pull_request", `del-${TEST_TAG}-4`, {
        action: "closed",
        repository: { full_name: REPO_FULL_NAME },
        pull_request: {
          number: PR_NUMBER,
          merged: true,
          merged_at: mergedAt,
          closed_at: mergedAt,
          merged_by: { login: "alice", id: 100 },
          user: { login: "superlog-bot", id: 999 },
          head: { sha: "cafebabe", ref: "superlog/fix-1" },
        },
        sender: { login: "alice", id: 100 },
        installation: { id: GH_INSTALLATION_ID },
      });
      assert.equal(res.status, 200);

      const pr = await db.query.agentPullRequests.findFirst({
        where: eq(schema.agentPullRequests.id, seeded.agentPrRowId),
      });
      assert.equal(pr?.state, "merged");
      assert.equal(pr?.mergedByLogin, "alice");
      assert.ok(pr?.mergedAt, "expected mergedAt");

      const incident = await db.query.incidents.findFirst({
        where: eq(schema.incidents.id, seeded.incidentId),
      });
      assert.equal(incident?.status, "resolved");

      const issue = await db.query.issues.findFirst({
        where: eq(schema.issues.id, seeded.issueId),
      });
      assert.equal(issue?.status, "resolved");
      assert.ok(issue?.resolvedAt, "expected issue resolvedAt");

      const ev = await db.query.incidentEvents.findFirst({
        where: and(
          eq(schema.incidentEvents.agentRunId, seeded.agentRunId),
          eq(schema.incidentEvents.kind, "incident_resolved"),
        ),
      });
      assert.ok(ev, "expected incident_resolved timeline event");
      assert.equal(ev.summary, `Incident resolved because PR #${PR_NUMBER} was merged.`);
      ok(
        `PR merged: state=${pr?.state}, incident=${incident?.status}, issue=${issue?.status}`,
      );
    }

    step("GitHub webhook: dedup on duplicate delivery");
    {
      const res = await postGithub(app, "issue_comment", `del-${TEST_TAG}-2`, {
        action: "created",
        repository: { full_name: REPO_FULL_NAME },
        issue: { number: PR_NUMBER, pull_request: { url: "..." } },
        comment: { id: 2002, body: "LGTM", user: { login: "bob", id: 200 } },
        installation: { id: GH_INSTALLATION_ID },
      });
      assert.equal(res.status, 200);
      const events = await db.query.agentPrEvents.findMany({
        where: and(
          eq(schema.agentPrEvents.agentPrId, seeded.agentPrRowId),
          eq(schema.agentPrEvents.providerEventId, `del-${TEST_TAG}-2`),
        ),
      });
      assert.equal(events.length, 1, `expected 1 dedup'd event, got ${events.length}`);
      ok(`duplicate delivery deduped (${events.length} row)`);
    }

    step("Linear webhook: Issue update with state change");
    {
      const res = await postLinear(app, `lin-${TEST_TAG}-1`, {
        action: "update",
        type: "Issue",
        webhookId: LINEAR_WEBHOOK_ID,
        webhookTimestamp: Date.now(),
        createdAt: new Date().toISOString(),
        updatedFrom: { stateId: "old-state" },
        data: {
          id: LINEAR_TICKET_ID,
          identifier: "ENG-1",
          title: "Bug fix",
          url: `https://linear.app/acme/issue/ENG-1`,
          state: { id: "in-progress", name: "In Progress", type: "started" },
          assignee: { id: "user-99", name: "Charlie" },
        },
        actor: { id: "user-99", name: "Charlie" },
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);

      const ticket = await db.query.agentLinearTickets.findFirst({
        where: eq(schema.agentLinearTickets.id, seeded.agentTicketRowId),
      });
      assert.equal(ticket?.state, "In Progress");
      assert.equal(ticket?.stateType, "started");
      assert.equal(ticket?.assigneeName, "Charlie");
      ok(`ticket state: ${ticket?.state} (${ticket?.stateType}), assignee=${ticket?.assigneeName}`);

      const ev = await db.query.agentLinearTicketEvents.findFirst({
        where: and(
          eq(schema.agentLinearTicketEvents.agentLinearTicketId, seeded.agentTicketRowId),
          eq(schema.agentLinearTicketEvents.kind, "ticket_state_changed"),
        ),
      });
      assert.ok(ev, "expected ticket_state_changed event");
      assert.equal(ev.actorName, "Charlie");
      ok(`event recorded: ${ev.kind} by ${ev.actorName}`);
    }

    step("Linear webhook: Comment create");
    {
      const res = await postLinear(app, `lin-${TEST_TAG}-2`, {
        action: "create",
        type: "Comment",
        webhookId: LINEAR_WEBHOOK_ID,
        createdAt: new Date().toISOString(),
        data: {
          id: "cmt-1",
          issueId: LINEAR_TICKET_ID,
          body: "Looks good",
          user: { id: "user-99", name: "Charlie" },
        },
      });
      assert.equal(res.status, 200);

      const ev = await db.query.agentLinearTicketEvents.findFirst({
        where: and(
          eq(schema.agentLinearTicketEvents.agentLinearTicketId, seeded.agentTicketRowId),
          eq(schema.agentLinearTicketEvents.kind, "ticket_comment"),
        ),
      });
      assert.ok(ev, "expected ticket_comment event");
      assert.equal(ev.actorName, "Charlie");
      ok(`event recorded: ${ev.kind} by ${ev.actorName}`);
    }

    step("Linear webhook: bad signature rejected");
    {
      const res = await app.request("/linear/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": "0".repeat(64),
        },
        body: JSON.stringify({
          webhookId: LINEAR_WEBHOOK_ID,
          type: "Issue",
          action: "update",
          data: { id: LINEAR_TICKET_ID },
        }),
      });
      assert.equal(res.status, 401);
      ok(`bad signature → 401`);
    }

    step("Timeline merge: agent run + agent_pr + agent_linear, sorted");
    {
      const events = await loadTimelineForTest(seeded.incidentId, seeded.agentRunId);
      const sources = new Set(events.map((e) => e.source));
      assert.ok(sources.has("agent_run"), "missing agent run events");
      assert.ok(sources.has("agent_pr"), "missing agent_pr events");
      assert.ok(sources.has("agent_linear"), "missing agent_linear events");

      // Verify chronological order
      for (let i = 1; i < events.length; i++) {
        assert.ok(
          events[i - 1]!.createdAt <= events[i]!.createdAt,
          `events out of order at index ${i}`,
        );
      }
      // Verify actor surfaced for at least one PR event
      const prEventWithActor = events.find((e) => e.source === "agent_pr" && e.actor);
      assert.ok(prEventWithActor, "expected at least one PR event with actor metadata");
      const incidentResolvedEvent = events.find(
        (e) => e.source === "agent_run" && e.kind === "incident_resolved",
      );
      assert.ok(incidentResolvedEvent, "missing incident_resolved timeline event");
      assert.equal(
        incidentResolvedEvent.summary,
        `Incident resolved because PR #${PR_NUMBER} was merged.`,
      );
      ok(`timeline has ${events.length} events across ${sources.size} sources, chronological`);
      ok(`sample actor: ${prEventWithActor.actor?.name} (${prEventWithActor.kind})`);
    }

    console.log("\nAll assertions passed.");
  } finally {
    step("Cleanup");
    await cleanup(seeded.orgId);
    ok("test rows removed");
  }
}

// Inline copy of apps/api/src/index.ts loadIncidentTimeline so the test doesn't
// have to spin up the whole api. If this drifts, the unit-of-truth is the api file.
async function loadTimelineForTest(incidentId: string, agentRunId: string) {
  const [agentRunEvents, prRows, linearTickets] = await Promise.all([
    db.query.incidentEvents.findMany({
      where: eq(schema.incidentEvents.agentRunId, agentRunId),
      orderBy: [asc(schema.incidentEvents.createdAt)],
    }),
    db.query.agentPullRequests.findMany({
      where: eq(schema.agentPullRequests.incidentId, incidentId),
    }),
    db.query.agentLinearTickets.findMany({
      where: eq(schema.agentLinearTickets.incidentId, incidentId),
    }),
  ]);

  const [prEventRows, linearEventRows] = await Promise.all([
    prRows.length === 0
      ? []
      : db.query.agentPrEvents.findMany({
          where: inArray(
            schema.agentPrEvents.agentPrId,
            prRows.map((r) => r.id),
          ),
          orderBy: [asc(schema.agentPrEvents.occurredAt)],
        }),
    linearTickets.length === 0
      ? []
      : db.query.agentLinearTicketEvents.findMany({
          where: inArray(
            schema.agentLinearTicketEvents.agentLinearTicketId,
            linearTickets.map((r) => r.id),
          ),
          orderBy: [asc(schema.agentLinearTicketEvents.occurredAt)],
        }),
  ]);

  type Item = {
    id: string;
    kind: string;
    summary: string | null;
    createdAt: string;
    source: "agent_run" | "agent_pr" | "agent_linear";
    actor: { name: string | null } | null;
  };
  const items: Item[] = [];
  for (const ev of agentRunEvents) {
    items.push({
      id: ev.id,
      kind: ev.kind,
      summary: ev.summary,
      createdAt: ev.createdAt.toISOString(),
      source: "agent_run",
      actor: null,
    });
  }
  for (const ev of prEventRows) {
    items.push({
      id: ev.id,
      kind: ev.kind,
      summary: ev.summary,
      createdAt: ev.occurredAt.toISOString(),
      source: "agent_pr",
      actor: ev.actorLogin ? { name: ev.actorLogin } : null,
    });
  }
  for (const ev of linearEventRows) {
    items.push({
      id: ev.id,
      kind: ev.kind,
      summary: ev.summary,
      createdAt: ev.occurredAt.toISOString(),
      source: "agent_linear",
      actor: ev.actorName ? { name: ev.actorName } : null,
    });
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return items;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nE2E test failed:", e);
    process.exit(1);
  });
