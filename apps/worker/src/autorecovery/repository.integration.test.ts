// Sets a dummy DATABASE_URL so importing @superlog/db's client doesn't throw at
// import time. This test never uses the postgres-js client — it runs against an
// in-process pglite instance — so the dummy URL is never dialed.
import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type DB, schema } from "@superlog/db";
import { type PgliteDatabase, drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { DEFAULT_AUTORECOVERY_POLICY } from "./policy.js";
import { createAutorecoveryRepository } from "./repository.js";

// Real-Postgres (pglite, in-process) coverage for the autorecovery candidate
// query. The query is raw SQL with correlated subqueries, so the fake-repo
// unit tests in tick.test.ts can't catch SQL-level regressions — this is the
// regression that would have caught the 42702 ambiguous-`id` crash that took
// autorecovery down in prod for a week.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../../../../packages/db/migrations");

const NOW = new Date("2026-05-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let repo: ReturnType<typeof createAutorecoveryRepository>;
let projectId: string;

before(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  repo = createAutorecoveryRepository(db as unknown as DB);

  const [org] = await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning();
  assert.ok(org);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  assert.ok(project);
  projectId = project.id;
});

after(async () => {
  await client.close();
});

type SeedOpts = {
  codename: string;
  lastSeen: Date;
  createdAt: Date;
  evaluatedAt?: Date | null;
  status?: schema.IncidentStatus;
  silenced?: boolean;
  exceptionType?: string;
  undecidedProposal?: boolean;
};

async function seedIncident(opts: SeedOpts): Promise<string> {
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId,
      title: opts.codename,
      codename: opts.codename,
      service: "@superlog/api",
      status: opts.status ?? "open",
      firstSeen: opts.createdAt,
      lastSeen: opts.lastSeen,
      createdAt: opts.createdAt,
      autorecoveryLastEvaluatedAt: opts.evaluatedAt ?? null,
    })
    .returning();
  assert.ok(incident);
  const [issue] = await db
    .insert(schema.issues)
    .values({
      projectId,
      fingerprint: `fp-${opts.codename}`,
      exceptionType: opts.exceptionType ?? "ERROR",
      title: `issue-${opts.codename}`,
      service: "@superlog/api",
      firstSeen: opts.createdAt,
      lastSeen: opts.lastSeen,
      silencedAt: opts.silenced ? opts.createdAt : null,
    })
    .returning();
  assert.ok(issue);
  await db.insert(schema.incidentIssues).values({ incidentId: incident.id, issueId: issue.id });
  if (opts.undecidedProposal) {
    await db.insert(schema.incidentResolutionProposals).values({
      incidentId: incident.id,
      proposedReasonCode: "external_dependency_recovered",
      proposedReasonText: "looks recovered",
      confidence: "medium",
    });
  }
  return incident.id;
}

test("selectCandidates: runs without 42702 and returns live issue signatures", async () => {
  const id = await seedIncident({
    codename: "solo-eligible",
    lastSeen: ago(10 * DAY),
    createdAt: ago(10 * DAY),
    exceptionType: "ResendDomainError",
  });

  const rows = await repo.selectCandidates(NOW, DEFAULT_AUTORECOVERY_POLICY);

  const row = rows.find((r) => r.id === id);
  assert.ok(row, "the eligible incident should be selected");
  assert.deepEqual(row.issueSignatures, [{ exceptionType: "ResendDomainError" }]);
});

test("selectCandidates: fair rotation + eligibility filters", async () => {
  await client.exec(
    "DELETE FROM incident_issues; DELETE FROM incident_resolution_proposals; DELETE FROM issues; DELETE FROM incidents;",
  );

  const a = await seedIncident({
    codename: "a-null-oldest",
    lastSeen: ago(10 * DAY),
    createdAt: ago(10 * DAY),
    evaluatedAt: null,
  });
  const b = await seedIncident({
    codename: "b-null-newer",
    lastSeen: ago(2 * DAY),
    createdAt: ago(2 * DAY),
    evaluatedAt: null,
  });
  const c = await seedIncident({
    codename: "c-evaluated-old",
    lastSeen: ago(5 * DAY),
    createdAt: ago(5 * DAY),
    evaluatedAt: ago(2 * DAY),
  });
  // Excluded:
  await seedIncident({
    codename: "d-cooldown",
    lastSeen: ago(5 * DAY),
    createdAt: ago(5 * DAY),
    evaluatedAt: ago(HOUR),
  });
  await seedIncident({
    codename: "e-recent-activity",
    lastSeen: ago(30 * 60 * 1000),
    createdAt: ago(10 * DAY),
  });
  await seedIncident({
    codename: "f-too-new",
    lastSeen: ago(30 * 60 * 1000),
    createdAt: ago(30 * 60 * 1000),
  });
  await seedIncident({
    codename: "g-all-silenced",
    lastSeen: ago(5 * DAY),
    createdAt: ago(5 * DAY),
    silenced: true,
  });
  await seedIncident({
    codename: "h-undecided-proposal",
    lastSeen: ago(5 * DAY),
    createdAt: ago(5 * DAY),
    undecidedProposal: true,
  });
  await seedIncident({
    codename: "i-resolved",
    lastSeen: ago(5 * DAY),
    createdAt: ago(5 * DAY),
    status: "resolved",
  });

  const rows = await repo.selectCandidates(NOW, DEFAULT_AUTORECOVERY_POLICY);

  // Only a, b, c are eligible — and in NULLS-FIRST, then stalest-last_seen order.
  assert.deepEqual(
    rows.map((r) => r.id),
    [a, b, c],
  );
});

test("markEvaluated: stamps the cursor so the incident drops out of the next pass", async () => {
  await client.exec(
    "DELETE FROM incident_issues; DELETE FROM incident_resolution_proposals; DELETE FROM issues; DELETE FROM incidents;",
  );

  const a = await seedIncident({
    codename: "a",
    lastSeen: ago(10 * DAY),
    createdAt: ago(10 * DAY),
  });
  const b = await seedIncident({ codename: "b", lastSeen: ago(9 * DAY), createdAt: ago(9 * DAY) });

  const before = await repo.selectCandidates(NOW, DEFAULT_AUTORECOVERY_POLICY);
  assert.deepEqual(
    before.map((r) => r.id),
    [a, b],
  );

  await repo.markEvaluated(a, NOW);

  const afterStamp = await repo.selectCandidates(NOW, DEFAULT_AUTORECOVERY_POLICY);
  assert.deepEqual(
    afterStamp.map((r) => r.id),
    [b],
    "just-evaluated incident is excluded by the cooldown",
  );
});
