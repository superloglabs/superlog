import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { createIncidentFromLinearSession } = await import("./linear-agent-session.js");

test("delegating a Linear issue creates one incident with the issue as its root", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  try {
    const [org] = await db
      .insert(schema.orgs)
      .values({ name: "Acme", slug: "acme-linear-incident" })
      .returning();
    assert.ok(org);
    const [project] = await db
      .insert(schema.projects)
      .values({ orgId: org.id, name: "App", slug: "app" })
      .returning();
    assert.ok(project);
    const [installation] = await db
      .insert(schema.linearInstallations)
      .values({ projectId: project.id, workspaceId: "workspace-1", accessToken: "token" })
      .returning();
    assert.ok(installation);
    const input = {
      installation,
      agentSessionId: "session-1",
      issueId: "issue-1",
      issueIdentifier: "ENG-42",
      issueTitle: "Checkout deploy is failing",
      issueUrl: "https://linear.app/acme/issue/ENG-42",
      prompt: "Investigate the checkout failure and propose a fix.",
      runtime: "anthropic",
      now: new Date("2026-07-14T10:00:00Z"),
    };

    const first = await createIncidentFromLinearSession(db, input);
    const retry = await createIncidentFromLinearSession(db, input);
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.incident.id, first.incident.id);

    const incidents = await db.query.incidents.findMany();
    const runs = await db.query.agentRuns.findMany();
    const roots = await db.query.linearAgentSessions.findMany();
    const tickets = await db.query.agentLinearTickets.findMany();
    assert.equal(incidents.length, 1);
    assert.equal(runs.length, 1);
    assert.equal(roots.length, 1);
    assert.equal(tickets.length, 1);
    assert.equal(runs[0]?.trigger, "linear");
    assert.equal(runs[0]?.prompt, input.prompt);
    assert.equal(roots[0]?.incidentId, incidents[0]?.id);
    assert.equal(tickets[0]?.ticketId, "issue-1");
    assert.equal(tickets[0]?.agentRunId, runs[0]?.id);
  } finally {
    await client.close();
  }
});
