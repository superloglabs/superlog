import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { createIncidentLifecycle, reserveAgentPullRequestBatch, resolveAgentIncident } =
  await import("./resolve-incident.js");

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
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
      title: "Resolve guarded by PR state",
      codename: `resolve-${crypto.randomUUID()}`,
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
  return { incident, agentRun, installation };
}

function resolutionInput(incidentId: string, agentRunId: string) {
  return {
    incidentId,
    kind: "agent_classification" as const,
    reasonCode: "agent_resolved",
    reasonText: "The remediation is complete.",
    agentRunId,
    resolvingAgentRunId: agentRunId,
    issueOutcomes: [],
  };
}

test("agent resolution is rejected while a canonical pull request is open", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, installation } = await seedAgentIncident(db);
    await db.insert(schema.agentPullRequests).values({
      incidentId: incident.id,
      agentRunId: agentRun.id,
      installationId: installation.id,
      repoFullName: "acme/api",
      prNumber: 42,
      url: "https://github.com/acme/api/pull/42",
      branchName: "ash/fix-api",
      baseBranch: "main",
      state: "open",
    });

    const result = await resolveAgentIncident(db, resolutionInput(incident.id, agentRun.id));

    assert.deepEqual(result, {
      disposition: "pull_requests_open",
      resolved: false,
      resolvedIssueCount: 0,
      pullRequests: [
        {
          repoFullName: "acme/api",
          prNumber: 42,
          url: "https://github.com/acme/api/pull/42",
        },
      ],
    });
    const after = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, incident.id),
    });
    assert.equal(after?.status, "open");
  } finally {
    await client.close();
  }
});

test("agent resolution is rejected while a pull request batch is still being delivered", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedAgentIncident(db);
    const reserved = await reserveAgentPullRequestBatch(db, {
      incidentId: incident.id,
      agentRunId: agentRun.id,
      batchKey: "tool-use-1",
      deliveries: [
        { repoFullName: "acme/api", deliveryId: "delivery-api" },
        { repoFullName: "acme/web", deliveryId: "delivery-web" },
      ],
      now: NOW,
    });
    assert.equal(reserved, true);

    const result = await resolveAgentIncident(db, resolutionInput(incident.id, agentRun.id));

    assert.deepEqual(result, {
      disposition: "pull_request_delivery_pending",
      resolved: false,
      resolvedIssueCount: 0,
    });
  } finally {
    await client.close();
  }
});

test("agent resolution succeeds when the Incident has no pull requests", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedAgentIncident(db);

    const result = await resolveAgentIncident(db, resolutionInput(incident.id, agentRun.id));

    assert.deepEqual(result, {
      disposition: "resolved",
      resolved: true,
      resolvedIssueCount: 0,
    });
    const after = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, incident.id),
    });
    assert.equal(after?.status, "resolved");
  } finally {
    await client.close();
  }
});

test("a stale agent run cannot resolve a manually reopened Incident", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedAgentIncident(db);
    const resolvedAt = new Date("2026-07-15T12:01:00.000Z");
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "manual_resolution",
      reasonText: "An operator resolved the Incident.",
      resolvedAt,
    });
    const resolvedIncident = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, incident.id),
    });
    assert.ok(resolvedIncident);
    await createIncidentLifecycle(db).reopenManually({
      incident: resolvedIncident,
      actor: {},
      reopenedAt: new Date(resolvedAt.getTime() + 1_000),
    });

    const result = await resolveAgentIncident(db, resolutionInput(incident.id, agentRun.id));

    assert.deepEqual(result, {
      disposition: "agent_run_not_current",
      resolved: false,
      resolvedIssueCount: 0,
    });
    const after = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, incident.id),
    });
    assert.equal(after?.status, "open");
    const staleRun = await db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, agentRun.id),
    });
    assert.equal(staleRun?.state, "complete");
  } finally {
    await client.close();
  }
});

test("a consumed PR-merge resolution event cannot close a manually reopened Incident", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, installation } = await seedAgentIncident(db);
    const [pullRequest] = await db
      .insert(schema.agentPullRequests)
      .values({
        incidentId: incident.id,
        agentRunId: agentRun.id,
        installationId: installation.id,
        repoFullName: "acme/api",
        prNumber: 42,
        url: "https://github.com/acme/api/pull/42",
        branchName: "ash/fix-api",
        baseBranch: "main",
        state: "merged",
        mergedAt: NOW,
        closedAt: NOW,
      })
      .returning();
    assert.ok(pullRequest);
    const eventDedupeKey = `incident_resolved:agent_pr:${pullRequest.id}`;
    const resolution = {
      incidentId: incident.id,
      kind: "agent_pr_merged" as const,
      reasonCode: "agent_pr_merged",
      reasonText: "All fixes merged.",
      agentRunId: agentRun.id,
      resolvingAgentRunId: null,
      eventDedupeKey,
      resolvedAt: NOW,
    };
    const lifecycle = createIncidentLifecycle(db);
    const first = await lifecycle.resolveIfAllAgentPullRequestsMerged(resolution);
    assert.equal(first.disposition, "resolved");
    const resolvedIncident = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, incident.id),
    });
    assert.ok(resolvedIncident);
    await createIncidentLifecycle(db).reopenManually({
      incident: resolvedIncident,
      actor: {},
      reopenedAt: new Date(NOW.getTime() + 1_000),
    });

    const redelivery = await lifecycle.resolveIfAllAgentPullRequestsMerged(resolution);

    assert.deepEqual(redelivery, {
      disposition: "resolution_event_already_consumed",
      resolved: false,
      resolvedIssueCount: 0,
    });
    const after = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, incident.id),
    });
    assert.equal(after?.status, "open");
  } finally {
    await client.close();
  }
});

test("a successful legacy agent resolution records its findings and noise verdict atomically", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedAgentIncident(db);
    const agentRunResult: schema.AgentRunResult = {
      state: "complete",
      summary: "The endpoint is behaving as designed.",
      rootCause: { text: "The probe intentionally exercises the error response.", confidence: 9 },
      noiseClassification: {
        reason: "expected_probe",
        evidence: "The response matches the documented probe behavior.",
        action: { kind: "silence" },
      },
    };

    const result = await resolveAgentIncident(db, {
      ...resolutionInput(incident.id, agentRun.id),
      reasonCode: "expected_probe",
      reasonText: "The response matches the documented probe behavior.",
      issueOutcomes: undefined,
      issueOutcome: { kind: "silence" },
      agentRunResult,
      resolvedAt: NOW,
    });

    assert.equal(result.disposition, "resolved");
    const after = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, incident.id),
    });
    assert.equal(after?.status, "resolved");
    assert.equal(after?.agentSummary, agentRunResult.summary);
    assert.deepEqual(after?.noiseClassification, agentRunResult.noiseClassification);
    assert.equal(after?.noiseReason, "expected_probe");
    assert.deepEqual(after?.noiseResolvedAt, NOW);
    assert.equal(after?.findingsAgentRunId, agentRun.id);
  } finally {
    await client.close();
  }
});

test("a blocked legacy agent resolution does not publish classification metadata", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, installation } = await seedAgentIncident(db);
    await db.insert(schema.agentPullRequests).values({
      incidentId: incident.id,
      agentRunId: agentRun.id,
      installationId: installation.id,
      repoFullName: "acme/api",
      prNumber: 42,
      url: "https://github.com/acme/api/pull/42",
      branchName: "ash/fix-api",
      baseBranch: "main",
      state: "open",
    });

    const result = await resolveAgentIncident(db, {
      ...resolutionInput(incident.id, agentRun.id),
      issueOutcomes: undefined,
      issueOutcome: { kind: "silence" },
      agentRunResult: {
        state: "complete",
        summary: "This should not become the Incident's verdict.",
        noiseClassification: {
          reason: "expected_probe",
          evidence: "A stale legacy session supplied this verdict.",
        },
      },
    });

    assert.equal(result.disposition, "pull_requests_open");
    const after = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, incident.id),
    });
    assert.equal(after?.status, "open");
    assert.equal(after?.agentSummary, null);
    assert.equal(after?.noiseClassification, null);
    assert.equal(after?.noiseReason, null);
    assert.equal(after?.resolutionClassification, null);
    assert.equal(after?.findingsAgentRunId, null);
  } finally {
    await client.close();
  }
});

test("closed and merged pull requests do not block agent resolution", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun, installation } = await seedAgentIncident(db);
    await db.insert(schema.agentPullRequests).values([
      {
        incidentId: incident.id,
        agentRunId: agentRun.id,
        installationId: installation.id,
        repoFullName: "acme/api",
        prNumber: 41,
        url: "https://github.com/acme/api/pull/41",
        branchName: "ash/abandoned-fix",
        baseBranch: "main",
        state: "closed",
        closedAt: NOW,
      },
      {
        incidentId: incident.id,
        agentRunId: agentRun.id,
        installationId: installation.id,
        repoFullName: "acme/api",
        prNumber: 42,
        url: "https://github.com/acme/api/pull/42",
        branchName: "ash/merged-fix",
        baseBranch: "main",
        state: "merged",
        mergedAt: NOW,
        closedAt: NOW,
      },
    ]);

    const result = await resolveAgentIncident(db, resolutionInput(incident.id, agentRun.id));

    assert.equal(result.disposition, "resolved");
    assert.equal(result.resolved, true);
  } finally {
    await client.close();
  }
});
