import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  type DB,
  applyAgentPullRequestState,
  resolveAgentIncident,
  schema,
  validateIncidentIssueOutcomes,
} from "@superlog/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  markAgentPullRequestClosedAfterDeliveryAbort,
  recordOpenedAgentPullRequest,
} from "./deliverable-records.js";
import type { OutcomeActionReceiptLock } from "./outcome-action-receipts.js";
import { createOutcomeActionExecutor } from "./outcome-actions.js";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/migrations",
);
const NOW = new Date("2026-07-15T12:00:00.000Z");

async function freshDb(): Promise<{ db: DB; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

async function seedAgentIncident(db: DB) {
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: "Acme", slug: `acme-${crypto.randomUUID()}` })
    .returning();
  assert.ok(org);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Project", slug: `project-${crypto.randomUUID()}` })
    .returning();
  assert.ok(project);
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: project.id,
      title: "Concurrent PR delivery and resolution",
      codename: `race-${crypto.randomUUID()}`,
      firstSeen: NOW,
      lastSeen: NOW,
    })
    .returning();
  assert.ok(incident);
  const [agentRun] = await db
    .insert(schema.agentRuns)
    .values({ incidentId: incident.id, runtime: "test", state: "running" })
    .returning();
  assert.ok(agentRun);
  const [installation] = await db
    .insert(schema.githubInstallations)
    .values({
      orgId: org.id,
      projectId: project.id,
      installationId: Math.floor(Math.random() * 1_000_000) + 1,
      accountLogin: "acme",
      accountType: "Organization",
      repos: [],
    })
    .returning();
  assert.ok(installation);
  return { project, incident, agentRun, installation };
}

type SeededAgentIncident = Awaited<ReturnType<typeof seedAgentIncident>>;

function recordPullRequest(db: DB, seeded: SeededAgentIncident) {
  return recordOpenedAgentPullRequest(
    {
      incidentId: seeded.incident.id,
      agentRunId: seeded.agentRun.id,
      installationRowId: seeded.installation.id,
      repoFullName: "acme/api",
      prNumber: 42,
      prNodeId: "PR_node_42",
      url: "https://github.com/acme/api/pull/42",
      branchName: "ash/fix-api",
      baseBranch: "main",
      headSha: "abc123",
      title: "Fix API",
      authorLogin: "superlog-app",
      authorGithubId: 123,
      authorAvatarUrl: null,
      state: "open",
      mergedAt: null,
    },
    { database: db, now: () => NOW, recordCreatedMetric: async () => {} },
  );
}

function resolveIncident(db: DB, seeded: SeededAgentIncident) {
  return resolveAgentIncident(db, {
    incidentId: seeded.incident.id,
    kind: "agent_classification",
    reasonCode: "agent_resolved",
    reasonText: "The remediation is complete.",
    agentRunId: seeded.agentRun.id,
    resolvingAgentRunId: seeded.agentRun.id,
    issueOutcomes: [],
  });
}

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

test("new-contract resolution projects findings while atomically resolving its Issues", async () => {
  const { db, client } = await freshDb();
  try {
    const seeded = await seedAgentIncident(db);
    const issues = await db
      .insert(schema.issues)
      .values([
        {
          projectId: seeded.project.id,
          fingerprint: `expected-probe-${crypto.randomUUID()}`,
          kind: "log",
          exceptionType: "ExpectedProbe",
          title: "Expected probe error",
          firstSeen: NOW,
          lastSeen: NOW,
        },
        {
          projectId: seeded.project.id,
          fingerprint: `recovered-alert-${crypto.randomUUID()}`,
          kind: "alert",
          exceptionType: "AlertEpisode",
          title: "Recovered latency alert",
          firstSeen: NOW,
          lastSeen: NOW,
        },
      ])
      .returning();
    const expectedProbe = issues[0];
    const recoveredAlert = issues[1];
    assert.ok(expectedProbe && recoveredAlert);
    await db.insert(schema.incidentIssues).values([
      { incidentId: seeded.incident.id, issueId: expectedProbe.id },
      { incidentId: seeded.incident.id, issueId: recoveredAlert.id },
    ]);

    let terminalResult: schema.AgentRunResult | undefined;
    const execute = createOutcomeActionExecutor(
      {
        incident: seeded.incident,
        agentRun: seeded.agentRun,
        project: seeded.project,
      } as Parameters<typeof createOutcomeActionExecutor>[0],
      "session-1",
      noReceiptLock,
      {
        validateIncidentIssueOutcomes: (_database, incidentId, outcomes) =>
          validateIncidentIssueOutcomes(db, incidentId, outcomes),
        resolveAgentIncident: (input) => {
          terminalResult = input.agentRunResult;
          return resolveAgentIncident(db, input);
        },
      },
    );
    const findings = {
      summary: "A routine probe created noise while the latency alert recovered.",
      proposedTitle: "Routine probe noise after latency alert recovery",
      rootCause: "The probe intentionally exercises the documented error response.",
      rootCauseConfidence: 9,
      estimatedImpact: "The probe error had no user impact; latency has returned to normal.",
      impactConfidence: 8,
      severity: "SEV-3" as const,
    };

    const execution = await execute({
      toolUseId: "resolve-with-findings",
      name: "resolve_incident",
      input: {
        reason: "The alert recovered and the remaining error is expected probe traffic.",
        evidence: "Latency remained below threshold and the probe matched its documented response.",
        issueOutcomes: [
          {
            issueId: expectedProbe.id,
            status: "silenced",
            reason: "This is expected probe traffic.",
            evidence: "The response matches the probe's documented error path.",
          },
          {
            issueId: recoveredAlert.id,
            status: "resolved",
            reason: "Latency recovered.",
            evidence: "Latency remained below the alert threshold.",
          },
        ],
      },
      hasFindings: true,
      findings,
    });

    assert.equal(execution.handled, true);
    if (!execution.handled || execution.deferAck) return;
    assert.equal(execution.ok, true);
    assert.equal(execution.payload.final, true);
    assert.deepEqual(terminalResult, {
      state: "complete",
      summary: findings.summary,
      proposedTitle: findings.proposedTitle,
      rootCause: { text: findings.rootCause, confidence: findings.rootCauseConfidence },
      rootCauseConfidence: "high",
      estimatedImpact: { text: findings.estimatedImpact, confidence: findings.impactConfidence },
      severity: findings.severity,
      incidentResolution: {
        reason: "The alert recovered and the remaining error is expected probe traffic.",
        evidence: "Latency remained below threshold and the probe matched its documented response.",
      },
      incidentResolutionEventDedupeKey: `incident_resolved:agent_run:${seeded.agentRun.id}:resolve_incident:resolve-with-findings`,
      issueClassifications: [
        {
          issueId: expectedProbe.id,
          action: "silence",
          reason: "This is expected probe traffic.",
          evidence: "The response matches the probe's documented error path.",
        },
        {
          issueId: recoveredAlert.id,
          action: "resolve",
          reason: "Latency recovered.",
          evidence: "Latency remained below the alert threshold.",
        },
      ],
    });

    const afterIncident = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, seeded.incident.id),
    });
    const afterExpectedProbe = await db.query.issues.findFirst({
      where: eq(schema.issues.id, expectedProbe.id),
    });
    const afterRecoveredAlert = await db.query.issues.findFirst({
      where: eq(schema.issues.id, recoveredAlert.id),
    });
    assert.equal(afterIncident?.status, "resolved");
    assert.equal(afterIncident?.resolvedReasonCode, "agent_resolved");
    assert.equal(
      afterIncident?.resolvedReasonText,
      "The alert recovered and the remaining error is expected probe traffic.",
    );
    assert.equal(afterIncident?.agentSummary, findings.summary);
    assert.equal(afterIncident?.title, findings.proposedTitle);
    assert.equal(afterIncident?.rootCauseText, findings.rootCause);
    assert.equal(afterIncident?.rootCauseConfidence, findings.rootCauseConfidence);
    assert.equal(afterIncident?.estimatedImpactText, findings.estimatedImpact);
    assert.equal(afterIncident?.estimatedImpactConfidence, findings.impactConfidence);
    assert.equal(afterIncident?.severity, findings.severity);
    assert.equal(afterIncident?.suggestedSeverity, findings.severity);
    assert.equal(afterIncident?.findingsAgentRunId, seeded.agentRun.id);
    assert.equal(afterExpectedProbe?.status, "silenced");
    assert.equal(afterRecoveredAlert?.status, "resolved");
  } finally {
    await client.close();
  }
});

test("concurrent PR recording and agent resolution accept only one terminal outcome", async () => {
  const { db, client } = await freshDb();
  try {
    const seeded = await seedAgentIncident(db);

    const [recording, resolution] = await Promise.all([
      recordPullRequest(db, seeded),
      resolveIncident(db, seeded),
    ]);

    assert.equal(recording.kind === "deliver" && resolution.disposition === "resolved", false);
    if (recording.kind === "deliver") {
      assert.equal(resolution.disposition, "pull_requests_open");
      const after = await db.query.incidents.findFirst({
        where: eq(schema.incidents.id, seeded.incident.id),
      });
      assert.equal(after?.status, "open");
    } else {
      assert.equal(recording.kind, "close_pull_request");
      assert.equal(resolution.disposition, "resolved");
    }
  } finally {
    await client.close();
  }
});

test("a PR recorded after agent resolution is rejected for compensation", async () => {
  const { db, client } = await freshDb();
  try {
    const seeded = await seedAgentIncident(db);

    const [resolution, recording] = await Promise.all([
      resolveIncident(db, seeded),
      recordPullRequest(db, seeded),
    ]);

    assert.equal(resolution.disposition, "resolved");
    assert.equal(recording.kind, "close_pull_request");
  } finally {
    await client.close();
  }
});

test("a delayed pre-compensation reopen cannot regress an aborted delivery close", async () => {
  const { db, client } = await freshDb();
  try {
    const seeded = await seedAgentIncident(db);
    const resolution = await resolveIncident(db, seeded);
    assert.equal(resolution.disposition, "resolved");
    const recording = await recordPullRequest(db, seeded);
    assert.equal(recording.kind, "close_pull_request");

    const providerCloseAt = new Date("2026-07-15T12:00:03.000Z");
    const marked = await markAgentPullRequestClosedAfterDeliveryAbort(
      {
        incidentId: seeded.incident.id,
        repoFullName: "acme/api",
        prNumber: 42,
        reason: "incident_not_open",
        providerObservation: {
          targetState: "closed",
          observedAt: new Date("2026-07-15T12:00:04.000Z"),
          providerUpdatedAt: providerCloseAt,
          closedAt: providerCloseAt,
        },
      },
      { database: db },
    );
    assert.equal(marked.canonicalState, "closed");

    const canonical = await db.query.agentPullRequests.findFirst({
      where: eq(schema.agentPullRequests.incidentId, seeded.incident.id),
    });
    assert.ok(canonical);
    const delayedReopen = await applyAgentPullRequestState(db, {
      incidentId: seeded.incident.id,
      agentPrId: canonical.id,
      targetState: "open",
      observedAt: new Date("2026-07-15T12:00:05.000Z"),
      providerUpdatedAt: new Date("2026-07-15T12:00:02.000Z"),
      closedAt: null,
    });

    assert.equal(delayedReopen.pullRequest?.state, "closed");
    assert.equal(
      delayedReopen.pullRequest?.providerUpdatedAt?.toISOString(),
      providerCloseAt.toISOString(),
    );
  } finally {
    await client.close();
  }
});
