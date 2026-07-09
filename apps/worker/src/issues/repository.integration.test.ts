// Sets a dummy DATABASE_URL so importing @superlog/db's client doesn't throw at
// import time. This test never uses the postgres-js client — it runs against an
// in-process pglite instance — so the dummy URL is never dialed.
import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type DB, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { type PgliteDatabase, drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { updateIssueGrouping } from "./repository.js";

// Real-Postgres (pglite, in-process) coverage for the updateIssueGrouping
// guards. The onlyIfUndecided guard is the one that keeps a losing
// concurrent-intake racer's out-of-lock 'pending' marker from clobbering the
// winner's recorded grouped/standalone verdict — a fake-repo unit test can't
// exercise the SQL WHERE clause, so this pins it directly.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../../../../packages/db/migrations");

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let projectId: string;

before(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [org] = await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning();
  assert.ok(org);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "P", slug: "p" })
    .returning();
  assert.ok(project);
  projectId = project.id;
});

async function makeIssue(overrides: Partial<typeof schema.issues.$inferInsert> = {}) {
  const [issue] = await db
    .insert(schema.issues)
    .values({
      projectId,
      kind: "alert",
      fingerprint: `alert-episode:${Math.random()}`,
      title: "breach",
      exceptionType: "AlertFired",
      firstSeen: new Date(),
      lastSeen: new Date(),
      ...overrides,
    })
    .returning();
  assert.ok(issue);
  return issue;
}

async function groupingOf(id: string) {
  const [row] = await db
    .select({ state: schema.issues.groupingState, source: schema.issues.groupingSource })
    .from(schema.issues)
    .where(eq(schema.issues.id, id));
  assert.ok(row);
  return row;
}

test("onlyIfUndecided lets the first 'pending' marker land on a fresh issue (source IS NULL)", async () => {
  const issue = await makeIssue();
  await updateIssueGrouping(
    issue.id,
    { state: "pending", source: "llm", reason: "Waiting for LLM grouping.", onlyIfUndecided: true },
    db as unknown as DB,
  );
  assert.equal((await groupingOf(issue.id)).state, "pending");
});

test("onlyIfUndecided does NOT overwrite a decided grouped verdict (the winner's verdict is protected)", async () => {
  const issue = await makeIssue();
  // Winner records its verdict (non-null source) inside the lock.
  await updateIssueGrouping(
    issue.id,
    { state: "grouped", source: "llm", reason: "same root cause" },
    db as unknown as DB,
  );
  // A losing racer's out-of-lock 'pending' write must be a no-op now.
  await updateIssueGrouping(
    issue.id,
    { state: "pending", source: "llm", reason: "Waiting for LLM grouping.", onlyIfUndecided: true },
    db as unknown as DB,
  );
  const after = await groupingOf(issue.id);
  assert.equal(after.state, "grouped");
  assert.equal(after.source, "llm");
});

test("onlyIfUndecided does NOT overwrite a decided standalone verdict", async () => {
  const issue = await makeIssue();
  await updateIssueGrouping(
    issue.id,
    { state: "standalone", source: "heuristic", reason: "no open incidents" },
    db as unknown as DB,
  );
  await updateIssueGrouping(
    issue.id,
    { state: "pending", source: "llm", reason: "Waiting for LLM grouping.", onlyIfUndecided: true },
    db as unknown as DB,
  );
  assert.equal((await groupingOf(issue.id)).state, "standalone");
});

test("onlyIfUndecided re-marks a retryable 'failed' issue (the grouping sweep can retry it)", async () => {
  const issue = await makeIssue();
  await updateIssueGrouping(
    issue.id,
    { state: "failed", source: "llm", reason: "LLM grouping failed" },
    db as unknown as DB,
  );
  await updateIssueGrouping(
    issue.id,
    { state: "pending", source: "llm", reason: "Waiting for LLM grouping.", onlyIfUndecided: true },
    db as unknown as DB,
  );
  assert.equal((await groupingOf(issue.id)).state, "pending");
});
