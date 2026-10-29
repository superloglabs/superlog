// Runs against the Postgres in DATABASE_URL, which it migrates.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, mock, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { postSlackMessage, updateSlackMessage } from "./api.js";
import {
  fetchSlackTargetsForOrg,
  postIncidentRootMessage,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "./incident-messages.js";

const orgIds: string[] = [];

before(async () => {
  await runMigrations();
});

afterEach(() => {
  mock.restoreAll();
});

after(async () => {
  try {
    for (const orgId of orgIds) await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
  } finally {
    await closeDb();
  }
});

function stubSlack() {
  return mock.method(globalThis, "fetch", async () => Response.json({ ok: true, ts: "1.000200" }));
}

async function seedOrg() {
  const tag = `slack-cut-over-${randomBytes(4).toString("hex")}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  return org;
}

async function seedProject(org: { id: string }, cutOverAt?: Date | null) {
  const tag = randomBytes(4).toString("hex");
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: tag, slug: tag })
    .returning();
  if (!project) throw new Error("seed project failed");
  const [installation] = await db
    .insert(schema.slackInstallations)
    .values({
      projectId: project.id,
      teamId: "T1",
      botAccessToken: `xoxb-${tag}`,
      channelId: `C${tag}`,
    })
    .returning();
  if (cutOverAt !== undefined) {
    await db.insert(schema.projectMigrations).values({
      projectId: project.id,
      workspaceUrl: "https://us.example.com",
      cutOverAt,
    });
  }
  const now = new Date();
  const [incident] = await db
    .insert(schema.incidents)
    .values({ projectId: project.id, title: "DB down", firstSeen: now, lastSeen: now })
    .returning();
  const [issue] = await db
    .insert(schema.issues)
    .values({
      projectId: project.id,
      fingerprint: tag,
      exceptionType: "Error",
      title: "DB down",
      service: "api",
      firstSeen: now,
      lastSeen: now,
    })
    .returning();
  if (!installation || !incident || !issue) throw new Error("seed incident failed");
  return { installation, project, incident, issue };
}

test("posts a new incident to a project's Slack channel until it is cut over", async () => {
  const org = await seedOrg();
  const staying = await seedProject(org, null);
  const moved = await seedProject(org, new Date());
  const slack = stubSlack();

  await postIncidentRootMessage({
    incident: staying.incident,
    projectId: staying.project.id,
    firstIssue: staying.issue,
  });
  const postsBeforeCutOver = slack.mock.callCount();
  await postIncidentRootMessage({
    incident: moved.incident,
    projectId: moved.project.id,
    firstIssue: moved.issue,
  });

  assert.ok(postsBeforeCutOver > 0);
  assert.equal(slack.mock.callCount(), postsBeforeCutOver);
  const movedIncident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, moved.incident.id),
  });
  assert.equal(movedIncident?.slackThreadTs, null);
});

test("stops thread replies and updates on a cut-over project's existing incident thread", async () => {
  const org = await seedOrg();
  const moved = await seedProject(org, new Date());
  await db
    .update(schema.incidents)
    .set({
      slackChannelId: moved.installation.channelId,
      slackThreadTs: "1.000100",
      slackInstallationId: moved.installation.id,
    })
    .where(eq(schema.incidents.id, moved.incident.id));
  const slack = stubSlack();

  await postIncidentThreadMessage(moved.incident.id, ":mag: Investigation queued.");
  await updateIncidentMainMessage(moved.incident.id, "Resolved", []);

  assert.equal(slack.mock.callCount(), 0);
});

test("leaves cut-over projects' channels out of org-level notifications", async () => {
  const org = await seedOrg();
  const staying = await seedProject(org);
  await seedProject(org, new Date());

  const targets = await fetchSlackTargetsForOrg(org.id);

  assert.deepEqual(
    targets.map((target) => target.channelId),
    [staying.installation.channelId],
  );
});

test("drops every post and update for a cut-over project's installation", async () => {
  const org = await seedOrg();
  const staying = await seedProject(org);
  const moved = await seedProject(org, new Date());
  const slack = stubSlack();
  const target = (installation: typeof moved.installation) => ({
    installationId: installation.id,
    channelId: installation.channelId ?? "",
    botToken: "xoxb-test",
  });

  const posted = await postSlackMessage({ target: target(staying.installation), text: "digest" });
  const dropped = await postSlackMessage({ target: target(moved.installation), text: "digest" });
  const updated = await updateSlackMessage({
    target: target(moved.installation),
    ts: "1.000100",
    text: "Resolved",
  });

  assert.equal(posted?.ok, true);
  assert.deepEqual(dropped, { ok: false, error: "project_cut_over" });
  assert.deepEqual(updated, { ok: false, error: "project_cut_over" });
  assert.equal(slack.mock.callCount(), 1);
});
