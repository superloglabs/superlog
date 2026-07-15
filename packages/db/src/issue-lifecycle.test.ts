import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

// resolve-incident.js transitively imports ./client.js, which throws at import
// time without a connection string. postgres-js connects lazily and every test
// here passes an explicit pglite DB, so a dummy value is enough.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const {
  createIncidentLifecycle,
  mergeIncidentsInTx,
  finalizeFulfilledAgentPullRequestBatches,
  reserveAgentPullRequestBatch,
  reconcileAgentRunCompletedByResolution,
} = await import("./resolve-incident.js");

// End-to-end lifecycle semantics on a real (in-process) Postgres:
//   - resolveIncident cascades the issue disposition (resolve / silence /
//     observe) to the issues whose current incident is the one closing, and
//     records an incident event per transition.
//   - openRecurrence starts a NEW incident chained to the predecessor, flips
//     the issue back to open, and appends (not repoints) the issue link.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, "expected a row");
  return row;
}

async function freshDb(): Promise<{ db: DB; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

async function seedProject(db: DB) {
  const org = one(await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning());
  const project = one(
    await db.insert(schema.projects).values({ orgId: org.id, name: "P", slug: "p" }).returning(),
  );
  return project;
}

async function seedIncidentWithIssue(
  db: DB,
  projectId: string,
  opts: { fingerprint: string; eventCount?: number },
) {
  const now = new Date();
  const issue = one(
    await db
      .insert(schema.issues)
      .values({
        projectId,
        fingerprint: opts.fingerprint,
        kind: "log",
        exceptionType: "Error",
        title: `boom ${opts.fingerprint}`,
        firstSeen: now,
        lastSeen: now,
        eventCount: opts.eventCount ?? 1,
      })
      .returning(),
  );
  const incident = one(
    await db
      .insert(schema.incidents)
      .values({
        projectId,
        title: issue.title,
        codename: `cn-${opts.fingerprint}`,
        status: "open",
        firstSeen: now,
        lastSeen: now,
      })
      .returning(),
  );
  await db.insert(schema.incidentIssues).values({ incidentId: incident.id, issueId: issue.id });
  return { issue, incident };
}

async function eventKinds(db: DB, incidentId: string): Promise<string[]> {
  const rows = await db.query.incidentEvents.findMany({
    where: eq(schema.incidentEvents.incidentId, incidentId),
  });
  return rows.map((r) => r.kind).sort();
}

async function assertStaleClosedMergeRollsBack(closedParticipant: "source" | "target") {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident: source } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: `fp-stale-${closedParticipant}-source`,
    });
    const { incident: target } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: `fp-stale-${closedParticipant}-target`,
    });
    const agentRun = one(
      await db
        .insert(schema.agentRuns)
        .values({ incidentId: source.id, runtime: "test", state: "running" })
        .returning(),
    );
    await createIncidentLifecycle(db).resolve({
      incidentId: closedParticipant === "source" ? source.id : target.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx
          .update(schema.agentRuns)
          .set({ state: "complete" })
          .where(eq(schema.agentRuns.id, agentRun.id));
        await mergeIncidentsInTx(tx, { sourceIncident: source, targetIncident: target });
      }),
      /mergeIncidentsInTx: cannot transition incident from "resolved"/,
    );

    const sourceAfter = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, source.id)),
    );
    const targetAfter = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, target.id)),
    );
    const runAfter = one(
      await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, agentRun.id)),
    );
    assert.equal(sourceAfter.status, closedParticipant === "source" ? "resolved" : "open");
    assert.equal(sourceAfter.mergedIntoId, null);
    assert.equal(targetAfter.status, closedParticipant === "target" ? "resolved" : "open");
    assert.equal(targetAfter.issueCount, target.issueCount);
    assert.equal(runAfter.state, closedParticipant === "source" ? "complete" : "running");
  } finally {
    await client.close();
  }
}

test("resolve with default outcome marks current issues resolved", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-1",
    });
    const result = await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });
    assert.equal(result.resolved, true);
    assert.equal(result.resolvedIssueCount, 1);

    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "resolved");
    const kinds = await eventKinds(db, incident.id);
    assert.ok(kinds.includes("incident_resolved"));
    assert.ok(kinds.includes("issue_resolved"));
  } finally {
    await client.close();
  }
});

test("resolving an incident completes parked agent runs without losing their deliverables", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-complete-parked-run",
    });
    const parkedResult: schema.AgentRunResult = {
      state: "awaiting_events",
      summary: "Opened the fix and waited for review.",
      prs: [
        {
          selectedRepoFullName: "acme/checkout",
          branchName: "fix/checkout",
          baseBranch: "main",
          title: "Fix checkout",
          openStatus: "opened",
          url: "https://example.test/acme/checkout/pull/42",
        },
      ],
    };
    const run = one(
      await db
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: "test",
          state: "awaiting_events",
          result: parkedResult,
        })
        .returning(),
    );
    const resolvedAt = new Date("2026-07-14T12:00:00.000Z");

    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
      resolvedAt,
    });

    const runAfter = one(
      await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)),
    );
    assert.equal(runAfter.state, "complete");
    assert.deepEqual(runAfter.completedAt, resolvedAt);
    assert.deepEqual(runAfter.result, { ...parkedResult, state: "complete" });
    const completionEvent = one(
      await db
        .select()
        .from(schema.incidentEvents)
        .where(eq(schema.incidentEvents.agentRunId, run.id)),
    );
    assert.equal(completionEvent.kind, "agent_run_completed");
    assert.equal(completionEvent.dedupeKey, `completed:${run.id}`);
    assert.deepEqual(completionEvent.processedAt, resolvedAt);
  } finally {
    await client.close();
  }
});

test("resolving an incident completes queued and repo-discovery runs before they can start", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-complete-not-started-runs",
    });
    const runs = await db
      .insert(schema.agentRuns)
      .values([
        { incidentId: incident.id, runtime: "test", state: "queued" },
        { incidentId: incident.id, runtime: "test", state: "repo_discovery" },
      ])
      .returning();
    const resolvedAt = new Date("2026-07-14T12:00:00.000Z");

    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
      resolvedAt,
    });

    for (const run of runs) {
      const after = one(
        await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)),
      );
      assert.equal(after.state, "complete");
      assert.deepEqual(after.completedAt, resolvedAt);
      assert.deepEqual(after.result, {
        state: "complete",
        summary: "Incident resolved; no further investigation is needed.",
      });
      const completionEvents = await db
        .select()
        .from(schema.incidentEvents)
        .where(
          and(
            eq(schema.incidentEvents.agentRunId, run.id),
            eq(schema.incidentEvents.kind, "agent_run_completed"),
          ),
        );
      assert.equal(completionEvents.length, 1);
    }
  } finally {
    await client.close();
  }
});

test("resolving an incident completes every non-terminal run except its resolver", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-complete-all-active-runs",
    });
    const runs = await db
      .insert(schema.agentRuns)
      .values([
        { incidentId: incident.id, runtime: "test", state: "running", trigger: "incident" },
        {
          incidentId: incident.id,
          runtime: "test",
          state: "awaiting_human",
          result: {
            state: "awaiting_human",
            summary: "Need deployment context.",
            question: "Which environment changed?",
          },
        },
        { incidentId: incident.id, runtime: "test", state: "resuming" },
        { incidentId: incident.id, runtime: "test", state: "pr_retry_queued" },
        { incidentId: incident.id, runtime: "test", state: "blocked_no_github" },
      ])
      .returning();
    const resolvedAt = new Date("2026-07-14T12:00:00.000Z");

    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
      resolvedAt,
    });

    for (const run of runs) {
      const after = one(
        await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)),
      );
      assert.equal(after.state, "complete", `${run.state} should be superseded`);
      assert.deepEqual(after.completedAt, resolvedAt);
      assert.equal(after.result?.state, "complete");
    }
  } finally {
    await client.close();
  }
});

test("a superseded result cannot overwrite Incident metadata after resolution", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-closed-metadata-guard",
    });
    const run = one(
      await db
        .insert(schema.agentRuns)
        .values({ incidentId: incident.id, runtime: "test", state: "complete" })
        .returning(),
    );
    const lifecycle = createIncidentLifecycle(db);
    await lifecycle.resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });

    const outcome = await lifecycle.applyAgentRunResult({
      incident,
      agentRunId: run.id,
      result: {
        state: "complete",
        summary: "Stale findings from a superseded pass.",
        proposedTitle: "Stale title from superseded pass",
        severity: "SEV-1",
      },
    });

    assert.deepEqual(outcome, { updated: false, noiseResolved: false });
    const after = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    assert.equal(after.title, incident.title);
    assert.equal(after.severity, incident.severity);
  } finally {
    await client.close();
  }
});

test("resolution completes another running follow-up but preserves the resolving run", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-complete-racing-follow-up",
    });
    const [resolvingRun, racingFollowUp] = await db
      .insert(schema.agentRuns)
      .values([
        {
          incidentId: incident.id,
          runtime: "test",
          state: "running",
          trigger: "pr_merged",
        },
        {
          incidentId: incident.id,
          runtime: "test",
          state: "running",
          trigger: "slack_reply",
          providerSessionId: "session-racing-follow-up",
          providerSessionStatus: "running",
        },
      ])
      .returning();
    assert.ok(resolvingRun);
    assert.ok(racingFollowUp);
    const resolvedAt = new Date("2026-07-14T12:00:00.000Z");

    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_pr_merged",
      reasonCode: "agent_pr_merged",
      reasonText: null,
      agentRunId: resolvingRun.id,
      resolvedAt,
    });

    const resolvingRunAfter = one(
      await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, resolvingRun.id)),
    );
    assert.equal(resolvingRunAfter.state, "running");
    assert.equal(resolvingRunAfter.completedAt, null);

    const racingFollowUpAfter = one(
      await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, racingFollowUp.id)),
    );
    assert.equal(racingFollowUpAfter.state, "complete");
    assert.equal(racingFollowUpAfter.providerSessionStatus, "termination_pending");
    assert.deepEqual(racingFollowUpAfter.completedAt, resolvedAt);
    assert.deepEqual(racingFollowUpAfter.result, {
      state: "complete",
      summary: "Incident resolved; no further investigation is needed.",
    });
  } finally {
    await client.close();
  }
});

test("resolution preserves terminal audit state while retiring every unreachable session", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-preserve-other-runs",
    });
    const terminalAt = new Date("2026-07-13T12:00:00.000Z");
    const originalRuns = await db
      .insert(schema.agentRuns)
      .values([
        {
          incidentId: incident.id,
          runtime: "test",
          state: "running",
          providerSessionId: "session-resolver",
          providerSessionStatus: "running",
        },
        {
          incidentId: incident.id,
          runtime: "test",
          state: "complete",
          providerSessionId: "session-complete",
          providerSessionStatus: "idle",
          completedAt: terminalAt,
          result: { state: "complete", summary: "Already complete." },
        },
        {
          incidentId: incident.id,
          runtime: "test",
          state: "failed",
          providerSessionId: "session-failed",
          providerSessionStatus: "idle",
          completedAt: terminalAt,
          result: { state: "failed", summary: "Already failed." },
        },
        {
          incidentId: incident.id,
          runtime: "test",
          state: "superseded",
          providerSessionId: "session-superseded",
          providerSessionStatus: "idle",
          completedAt: terminalAt,
        },
      ])
      .returning();

    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
      agentRunId: originalRuns[0]?.id,
      resolvedAt: new Date("2026-07-14T12:00:00.000Z"),
    });

    for (const original of originalRuns) {
      const after = one(
        await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, original.id)),
      );
      assert.equal(after.state, original.state);
      assert.deepEqual(after.result, original.result);
      assert.deepEqual(after.completedAt, original.completedAt);
      assert.equal(
        after.providerSessionStatus,
        original.id === originalRuns[0]?.id ? "running" : "termination_pending",
      );
    }
  } finally {
    await client.close();
  }
});

test("a terminal snapshot reconciles once after an external resolver wins", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-reconcile-completion-race",
    });
    const run = one(
      await db
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: "test",
          state: "running",
          providerSessionId: "session-reconcile",
          providerSessionStatus: "running",
        })
        .returning(),
    );
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });

    const result: schema.AgentRunResult = {
      state: "complete",
      summary: "Collected the real terminal findings.",
      rootCause: { text: "A dependency timed out.", confidence: 9 },
      rootCauseConfidence: "high",
    };
    const first = await reconcileAgentRunCompletedByResolution(db, {
      agentRunId: run.id,
      result,
      cumulativeRuntimeMinutes: 4,
    });
    const repeated = await reconcileAgentRunCompletedByResolution(db, {
      agentRunId: run.id,
      result: { ...result, summary: "Duplicate collector result." },
      cumulativeRuntimeMinutes: 5,
    });

    assert.equal(first, true);
    assert.equal(repeated, false);
    const after = one(
      await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)),
    );
    assert.deepEqual(after.result, result);
    assert.equal(after.cumulativeRuntimeMinutes, 4);
    assert.equal(after.providerSessionStatus, "termination_pending");
  } finally {
    await client.close();
  }
});

test("all-merged resolution waits for every repository reserved by a terminal PR batch", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-pr-batch-reservation",
    });
    const [run] = await db
      .insert(schema.agentRuns)
      .values({ incidentId: incident.id, runtime: "test", state: "running" })
      .returning();
    assert.ok(run);
    const [installation] = await db
      .insert(schema.githubInstallations)
      .values({
        orgId: project.orgId,
        projectId: project.id,
        installationId: 919191,
        accountLogin: "acme",
        accountType: "Organization",
        repos: [],
      })
      .returning();
    assert.ok(installation);
    const reservedAt = new Date("2026-07-14T12:00:00.000Z");
    await db.insert(schema.agentPullRequests).values({
      incidentId: incident.id,
      agentRunId: run.id,
      installationId: installation.id,
      repoFullName: "acme/api",
      prNumber: 1,
      url: "https://github.com/acme/api/pull/1",
      branchName: "ash/fix-api",
      baseBranch: "main",
      state: "merged",
      updatedAt: new Date(reservedAt.getTime() - 1_000),
    });
    await db.insert(schema.agentPullRequests).values({
      incidentId: incident.id,
      agentRunId: run.id,
      installationId: installation.id,
      repoFullName: "acme/web",
      prNumber: 2,
      url: "https://github.com/acme/web/pull/2",
      branchName: "ash/old-web-fix",
      baseBranch: "main",
      state: "merged",
      updatedAt: new Date(reservedAt.getTime() - 1_000),
    });
    await reserveAgentPullRequestBatch(db, {
      incidentId: incident.id,
      agentRunId: run.id,
      batchKey: "tool-batch-1",
      deliveries: [
        { repoFullName: "acme/api", deliveryId: "delivery-api-original" },
        { repoFullName: "acme/web", deliveryId: "delivery-web-original" },
      ],
      now: reservedAt,
    });

    assert.equal(
      await finalizeFulfilledAgentPullRequestBatches(db, {
        incidentId: incident.id,
        agentRunId: run.id,
        deliveries: [
          { repoFullName: "acme/api", deliveryId: "delivery-api-original" },
          { repoFullName: "acme/web", deliveryId: "delivery-web-original" },
        ],
        now: new Date(reservedAt.getTime() + 500),
      }),
      0,
      "older PRs in the same repositories must not fulfill a new batch",
    );

    const lifecycle = createIncidentLifecycle(db);
    const partial = await lifecycle.resolveIfAllAgentPullRequestsMerged({
      incidentId: incident.id,
      kind: "agent_pr_merged",
      reasonCode: "agent_pr_merged",
      reasonText: "All fixes merged.",
    });
    assert.equal(partial.disposition, "pull_requests_pending");

    const successor = one(
      await db
        .insert(schema.agentRuns)
        .values({ incidentId: incident.id, runtime: "test", state: "running" })
        .returning(),
    );
    await db.insert(schema.incidentEvents).values([
      {
        incidentId: incident.id,
        agentRunId: run.id,
        kind: "internal_agent_outcome_pr_delivery",
        detail: { repoFullName: "acme/api", deliveryId: "delivery-api-original" },
        dedupeKey: "delivery-receipt-api-original",
        processedAt: new Date(reservedAt.getTime() + 1_000),
        createdAt: new Date(reservedAt.getTime() + 1_000),
      },
      {
        incidentId: incident.id,
        agentRunId: successor.id,
        kind: "internal_agent_outcome_pr_delivery",
        detail: { repoFullName: "acme/web", deliveryId: "delivery-web-retry" },
        dedupeKey: "delivery-receipt-web-retry",
        processedAt: new Date(reservedAt.getTime() + 2_000),
        createdAt: new Date(reservedAt.getTime() + 2_000),
      },
    ]);
    assert.equal(
      await finalizeFulfilledAgentPullRequestBatches(db, {
        incidentId: incident.id,
        agentRunId: successor.id,
        deliveries: [{ repoFullName: "acme/web", deliveryId: "delivery-web-retry" }],
        now: new Date(reservedAt.getTime() + 3_000),
      }),
      1,
    );
    const complete = await lifecycle.resolveIfAllAgentPullRequestsMerged({
      incidentId: incident.id,
      kind: "agent_pr_merged",
      reasonCode: "agent_pr_merged",
      reasonText: "All fixes merged.",
    });
    assert.equal(complete.disposition, "resolved");
  } finally {
    await client.close();
  }
});

test("a winning non-PR resolution abandons incomplete PR batch reservations", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-pr-batch-abandoned-by-resolution",
    });
    const run = one(
      await db
        .insert(schema.agentRuns)
        .values({ incidentId: incident.id, runtime: "test", state: "running" })
        .returning(),
    );
    await reserveAgentPullRequestBatch(db, {
      incidentId: incident.id,
      agentRunId: run.id,
      batchKey: "tool-batch-abandoned",
      deliveries: [
        { repoFullName: "acme/api", deliveryId: "delivery-api" },
        { repoFullName: "acme/web", deliveryId: "delivery-web" },
      ],
    });

    const resolved = await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: "No code change is needed.",
    });

    assert.equal(resolved.resolved, true);
    const reservation = one(
      await db
        .select({ processedAt: schema.incidentEvents.processedAt })
        .from(schema.incidentEvents)
        .where(
          and(
            eq(schema.incidentEvents.incidentId, incident.id),
            eq(schema.incidentEvents.kind, "internal_agent_pr_batch_pending"),
          ),
        ),
    );
    assert.ok(reservation.processedAt);
  } finally {
    await client.close();
  }
});

test("manual reopen retires a stale PR batch reservation inherited from a merge", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-reopen-stale-pr-batch",
    });
    const run = one(
      await db
        .insert(schema.agentRuns)
        .values({ incidentId: incident.id, runtime: "test", state: "running" })
        .returning(),
    );
    await reserveAgentPullRequestBatch(db, {
      incidentId: incident.id,
      agentRunId: run.id,
      batchKey: "tool-batch-before-merge",
      deliveries: [
        { repoFullName: "acme/api", deliveryId: "delivery-api" },
        { repoFullName: "acme/web", deliveryId: "delivery-web" },
      ],
    });
    const mergedAt = new Date("2026-07-14T15:00:00.000Z");
    const merged = one(
      await db
        .update(schema.incidents)
        .set({ status: "merged", mergedAt, updatedAt: mergedAt })
        .where(eq(schema.incidents.id, incident.id))
        .returning(),
    );

    const reopened = await createIncidentLifecycle(db).reopenManually({
      incident: merged,
      actor: {},
      reopenedAt: new Date(mergedAt.getTime() + 1_000),
    });

    assert.equal(reopened.reopened, true);
    const reservation = one(
      await db
        .select({ processedAt: schema.incidentEvents.processedAt })
        .from(schema.incidentEvents)
        .where(
          and(
            eq(schema.incidentEvents.incidentId, incident.id),
            eq(schema.incidentEvents.kind, "internal_agent_pr_batch_pending"),
          ),
        ),
    );
    assert.ok(reservation.processedAt);
  } finally {
    await client.close();
  }
});

test("repeated resolution does not complete a parked run twice", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-idempotent-parked-run-completion",
    });
    const run = one(
      await db
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: "test",
          state: "awaiting_events",
          result: { state: "awaiting_events", summary: "Waiting for review." },
        })
        .returning(),
    );
    const firstResolvedAt = new Date("2026-07-14T12:00:00.000Z");
    const lifecycle = createIncidentLifecycle(db);

    const first = await lifecycle.resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
      resolvedAt: firstResolvedAt,
    });
    const repeated = await lifecycle.resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
      resolvedAt: new Date("2026-07-14T13:00:00.000Z"),
    });

    assert.equal(first.resolved, true);
    assert.equal(repeated.resolved, false);
    const runAfter = one(
      await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)),
    );
    assert.deepEqual(runAfter.completedAt, firstResolvedAt);
    const completionEvents = await db
      .select()
      .from(schema.incidentEvents)
      .where(
        and(
          eq(schema.incidentEvents.agentRunId, run.id),
          eq(schema.incidentEvents.kind, "agent_run_completed"),
        ),
      );
    assert.equal(completionEvents.length, 1);
  } finally {
    await client.close();
  }
});

test("resolve with silence outcome silences current issues", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-2",
    });
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "not_an_issue",
      reasonText: null,
      issueOutcome: { kind: "silence" },
    });
    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "silenced");
    assert.ok(after.silencedAt);
    assert.ok((await eventKinds(db, incident.id)).includes("issue_silenced"));
  } finally {
    await client.close();
  }
});

test("silence cascade resolves alert-episode issues plainly (never silences them)", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "alert-episode:ep-1",
    });
    await db.update(schema.issues).set({ kind: "alert" }).where(eq(schema.issues.id, issue.id));
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "not_an_issue",
      reasonText: null,
      issueOutcome: { kind: "silence" },
    });
    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "resolved");
    assert.equal(after.silencedAt, null);
    const kinds = await eventKinds(db, incident.id);
    assert.ok(kinds.includes("issue_resolved"));
    assert.ok(!kinds.includes("issue_silenced"));
  } finally {
    await client.close();
  }
});

test("resolve with observe outcome stores the trigger and baseline", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-3",
      eventCount: 42,
    });
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "expected_third_party",
      reasonText: "flaky upstream",
      issueOutcome: { kind: "observe", trigger: { kind: "count", count: 100 } },
    });
    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "under_observation");
    assert.deepEqual(after.escalationTrigger, { kind: "count", count: 100 });
    assert.equal(after.observationBaselineEventCount, 42);
    assert.ok(after.observationStartedAt);
    assert.ok((await eventKinds(db, incident.id)).includes("issue_observed"));
  } finally {
    await client.close();
  }
});

test("agent resolve applies distinct issue outcomes and closes the incident atomically", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue: logIssue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-atomic-log",
    });
    const alertIssue = one(
      await db
        .insert(schema.issues)
        .values({
          projectId: project.id,
          fingerprint: "fp-atomic-alert",
          kind: "log",
          exceptionType: "AlertBreach",
          title: "checkout latency alert",
          firstSeen: new Date(),
          lastSeen: new Date(),
          eventCount: 1,
        })
        .returning(),
    );
    await db
      .update(schema.issues)
      .set({ kind: "alert" })
      .where(eq(schema.issues.id, alertIssue.id));
    await db
      .insert(schema.incidentIssues)
      .values({ incidentId: incident.id, issueId: alertIssue.id });

    const result = await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "No further action is needed.",
      issueOutcomes: [
        {
          issueId: logIssue.id,
          action: "silence",
          reason: "Expected probe traffic has no user impact.",
          evidence: "The request completed through the documented no-op path.",
        },
        {
          issueId: alertIssue.id,
          action: "resolve",
          reason: "The alert recovered.",
          evidence: "The metric remained below threshold for 30 minutes.",
        },
      ],
    });

    assert.equal(result.resolved, true);
    const issues = await db.query.issues.findMany();
    assert.equal(issues.find((issue) => issue.id === logIssue.id)?.status, "silenced");
    assert.equal(issues.find((issue) => issue.id === alertIssue.id)?.status, "resolved");
    const incidentAfter = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    assert.equal(incidentAfter.status, "resolved");
  } finally {
    await client.close();
  }
});

test("agent resolve accepts an exact empty outcome set for an Incident with no Issues", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const now = new Date("2026-07-14T12:00:00.000Z");
    const incident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "Delegated investigation",
          codename: "zero-issue-agent-resolve",
          status: "open",
          firstSeen: now,
          lastSeen: now,
        })
        .returning(),
    );

    const result = await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "agent_resolved",
      reasonText: "The delegated investigation is complete.",
      issueOutcomes: [],
      resolvedAt: now,
    });

    assert.deepEqual(result, { resolved: true, resolvedIssueCount: 0 });
    const after = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    assert.equal(after.status, "resolved");
    assert.ok((await eventKinds(db, incident.id)).includes("incident_resolved"));
  } finally {
    await client.close();
  }
});

test("an invalid agent issue outcome leaves every issue and the incident unchanged", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-atomic-invalid",
    });
    await db.update(schema.issues).set({ kind: "alert" }).where(eq(schema.issues.id, issue.id));

    await assert.rejects(
      createIncidentLifecycle(db).resolve({
        incidentId: incident.id,
        kind: "agent_classification",
        reasonCode: "agent_resolved",
        reasonText: "Incorrect classification should roll back.",
        issueOutcomes: [
          {
            issueId: issue.id,
            action: "silence",
            reason: "noise",
            evidence: "not enough",
          },
        ],
      }),
      /alert episode.*only be resolved/i,
    );

    const issueAfter = one(
      await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)),
    );
    const incidentAfter = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    assert.equal(issueAfter.status, "open");
    assert.equal(incidentAfter.status, "open");
    assert.deepEqual(await eventKinds(db, incident.id), []);
  } finally {
    await client.close();
  }
});

test("an Issue cannot be linked after Incident resolution wins the lifecycle lock", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-link-after-resolve",
    });
    const lifecycle = createIncidentLifecycle(db);
    await lifecycle.resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });
    const lateIssue = one(
      await db
        .insert(schema.issues)
        .values({
          projectId: project.id,
          fingerprint: "fp-too-late",
          kind: "log",
          exceptionType: "Error",
          title: "late error",
          firstSeen: new Date(),
          lastSeen: new Date(),
        })
        .returning(),
    );

    const linked = await lifecycle.linkIssueToOpenIncident({
      incidentId: incident.id,
      issue: lateIssue,
    });

    assert.equal(linked, "incident_closed");
    const links = await db.query.incidentIssues.findMany({
      where: eq(schema.incidentIssues.issueId, lateIssue.id),
    });
    assert.deepEqual(links, []);
  } finally {
    await client.close();
  }
});

test("merge reloads a stale target and rolls back the caller transaction when it has closed", async () => {
  await assertStaleClosedMergeRollsBack("target");
});

test("merge reloads a stale source and rolls back the caller transaction when it has closed", async () => {
  await assertStaleClosedMergeRollsBack("source");
});

test("resolving an old incident does not touch issues that recurred into a newer one", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-4",
    });
    // Simulate a recurrence: issue got linked to a newer incident later.
    const newer = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: issue.title,
          codename: "cn-newer",
          status: "open",
          firstSeen: new Date(),
          lastSeen: new Date(),
          previousIncidentId: incident.id,
        })
        .returning(),
    );
    await db.insert(schema.incidentIssues).values({
      incidentId: newer.id,
      issueId: issue.id,
      createdAt: new Date(Date.now() + 1000),
    });

    const result = await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });
    assert.equal(result.resolved, true);
    assert.equal(result.resolvedIssueCount, 0);
    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "open");
  } finally {
    await client.close();
  }
});

test("openRecurrence chains a new incident, reopens the issue, and appends the link", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-5",
    });
    const lifecycle = createIncidentLifecycle(db);
    await lifecycle.resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });
    const resolvedIssue = one(
      await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)),
    );
    assert.equal(resolvedIssue.status, "resolved");

    const recurrence = await lifecycle.openRecurrence({
      previousIncident: incident,
      issue: resolvedIssue,
      origin: "resolved_issue_recurred",
    });
    assert.notEqual(recurrence.id, incident.id);
    assert.equal(recurrence.status, "open");
    assert.equal(recurrence.previousIncidentId, incident.id);

    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "open");
    assert.equal(after.silencedAt, null);

    const links = await db.query.incidentIssues.findMany({
      where: eq(schema.incidentIssues.issueId, issue.id),
    });
    assert.equal(links.length, 2);

    const newKinds = await eventKinds(db, recurrence.id);
    assert.ok(newKinds.includes("incident_opened_from_recurrence"));
    assert.ok(newKinds.includes("issue_reopened"));
    const oldKinds = await eventKinds(db, incident.id);
    assert.ok(oldKinds.includes("issue_recurred"));
  } finally {
    await client.close();
  }
});
