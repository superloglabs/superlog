import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import { closeIncidentOpenPullRequestsAfterResolution } from "./incident-pr-resolution.js";
import * as schema from "./schema.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { createIncidentLifecycle } = await import("./resolve-incident.js");

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, "expected one row");
  return row;
}

test("a manual API resolution reopens its pull request when the Incident reopens during provider closure", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });

  try {
    const org = one(
      await db
        .insert(schema.orgs)
        .values({ name: "Manual resolution org", slug: "manual-resolution-org" })
        .returning(),
    );
    const project = one(
      await db
        .insert(schema.projects)
        .values({
          orgId: org.id,
          name: "Manual resolution project",
          slug: "manual-resolution-project",
        })
        .returning(),
    );
    const installation = one(
      await db
        .insert(schema.githubInstallations)
        .values({
          orgId: org.id,
          projectId: project.id,
          installationId: 101,
          accountLogin: "acme",
          accountType: "Organization",
        })
        .returning(),
    );
    const incident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "Manual resolution race",
          codename: "manual-resolution-race",
          status: "open",
          firstSeen: new Date("2026-07-15T10:00:00.000Z"),
          lastSeen: new Date("2026-07-15T10:00:00.000Z"),
        })
        .returning(),
    );
    const agentRun = one(
      await db
        .insert(schema.agentRuns)
        .values({ incidentId: incident.id, runtime: "test", state: "complete" })
        .returning(),
    );
    const pullRequest = one(
      await db
        .insert(schema.agentPullRequests)
        .values({
          incidentId: incident.id,
          agentRunId: agentRun.id,
          installationId: installation.id,
          repoFullName: "acme/api",
          prNumber: 42,
          url: "https://github.com/acme/api/pull/42",
          branchName: "fix/manual-resolution-race",
          baseBranch: "main",
          state: "open",
        })
        .returning(),
    );
    const eventDedupeKey = `incident_resolved:dashboard:${incident.id}:manual-test`;
    const lifecycle = createIncidentLifecycle(db);
    const resolution = await lifecycle.resolveWithProof({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: "Resolved from the dashboard.",
      eventDedupeKey,
      resolvedAt: new Date("2026-07-15T11:00:00.000Z"),
    });
    assert.ok(resolution.resolutionProof);
    assert.deepEqual(resolution.resolutionProof, {
      agentRunId: null,
      eventDedupeKey,
    });

    let providerCloseCount = 0;
    let providerReopenCount = 0;
    const clock = [new Date("2026-07-15T11:04:00.000Z"), new Date("2026-07-15T11:06:00.000Z")];
    const sideEffects = await closeIncidentOpenPullRequestsAfterResolution({
      incidentId: incident.id,
      resolutionProof: resolution.resolutionProof,
      database: db,
      now: () => clock.shift() ?? new Date("2026-07-15T11:06:00.000Z"),
      closePullRequest: async () => {
        providerCloseCount += 1;
        const resolvedIncident = one(
          await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
        );
        await lifecycle.reopenManually({
          incident: resolvedIncident,
          actor: { userId: null },
          reopenedAt: new Date("2026-07-15T11:05:00.000Z"),
        });
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-15T11:04:30.000Z"),
        };
      },
      reopenPullRequest: async () => {
        providerReopenCount += 1;
        return {
          ok: true,
          providerUpdatedAt: new Date("2026-07-15T11:05:30.000Z"),
        };
      },
    });

    assert.deepEqual(sideEffects, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
    assert.equal(providerCloseCount, 1);
    assert.equal(providerReopenCount, 1);
    const pullRequestAfter = one(
      await db
        .select()
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pullRequest.id)),
    );
    assert.equal(pullRequestAfter.state, "open");
    assert.equal(pullRequestAfter.closedAt, null);
  } finally {
    await client.close();
  }
});

test("a repeated manual API resolution returns the current exact resolution proof", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });

  try {
    const org = one(
      await db
        .insert(schema.orgs)
        .values({ name: "Resolution retry org", slug: "resolution-retry-org" })
        .returning(),
    );
    const project = one(
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: "Resolution retry", slug: "resolution-retry" })
        .returning(),
    );
    const incident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "Resolution retry",
          codename: "resolution-retry",
          status: "open",
          firstSeen: new Date("2026-07-15T10:00:00.000Z"),
          lastSeen: new Date("2026-07-15T10:00:00.000Z"),
        })
        .returning(),
    );
    const lifecycle = createIncidentLifecycle(db);
    const eventDedupeKey = `incident_resolved:dashboard:${incident.id}:first`;
    const first = await lifecycle.resolveWithProof({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: "First request won.",
      eventDedupeKey,
      resolvedAt: new Date("2026-07-15T11:00:00.000Z"),
    });
    const repeated = await lifecycle.resolveWithProof({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: "Repeated request refreshes side effects.",
      resolvedAt: new Date("2026-07-15T11:05:00.000Z"),
    });

    assert.equal(first.resolved, true);
    assert.equal(repeated.resolved, false);
    assert.deepEqual(repeated.resolutionProof, {
      agentRunId: null,
      eventDedupeKey,
    });
  } finally {
    await client.close();
  }
});
