import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, mock, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { offerFollowUpForFeedback } from "./follow-up-offer.js";
import { updateResolvedIncidentSlackRootMessage } from "./incidents/resolution-side-effects.js";
import { handleSlackEventEnvelope } from "./slack.js";

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

async function seedSlackProject(cutOverAt?: Date) {
  const tag = randomBytes(4).toString("hex");
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `slack-cut-over-${tag}`, slug: `slack-cut-over-${tag}` })
    .returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  if (!project) throw new Error("seed project failed");
  const teamId = `T${tag}`;
  const channelId = `C${tag}`;
  await db.insert(schema.slackInstallations).values({
    projectId: project.id,
    teamId,
    botUserId: "UBOT",
    botAccessToken: `xoxb-${tag}`,
    channelId,
  });
  if (cutOverAt) {
    await db.insert(schema.projectMigrations).values({
      projectId: project.id,
      workspaceUrl: "https://us.example.com",
      cutOverAt,
    });
  }
  const [installation] = await db
    .select()
    .from(schema.slackInstallations)
    .where(eq(schema.slackInstallations.projectId, project.id));
  if (!installation) throw new Error("seed installation failed");
  return { channelId, installationId: installation.id, projectId: project.id, teamId };
}

// An incident with a Slack thread and a finished investigation.
async function seedIncidentThread(seeded: Awaited<ReturnType<typeof seedSlackProject>>) {
  const now = new Date();
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: seeded.projectId,
      title: "DB down",
      firstSeen: now,
      lastSeen: now,
      slackChannelId: seeded.channelId,
      slackThreadTs: "1700000000.000001",
      slackInstallationId: seeded.installationId,
    })
    .returning();
  if (!incident) throw new Error("seed incident failed");
  await db.insert(schema.agentRuns).values({ incidentId: incident.id, state: "complete" });
  return incident;
}

function feedbackOn(incidentId: string): schema.Feedback {
  return {
    id: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0",
    kind: "incident",
    refId: incidentId,
    source: "dialog",
    body: "The root cause was the connection pool.",
  } as schema.Feedback;
}

function mention(seeded: { channelId: string; teamId: string }) {
  return handleSlackEventEnvelope({
    type: "event_callback",
    event_id: `Ev${randomBytes(4).toString("hex")}`,
    team_id: seeded.teamId,
    event: {
      type: "message",
      text: "<@UBOT> why is checkout slow?",
      channel: seeded.channelId,
      user: "UHUMAN",
      ts: "1700000000.000100",
    },
  });
}

async function chatsFor(projectId: string) {
  return db.query.agentChats.findMany({ where: eq(schema.agentChats.projectId, projectId) });
}

test("answers a bot mention for a project that is not cut over", async () => {
  const slack = mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const seeded = await seedSlackProject();

  await mention(seeded);

  assert.equal((await chatsFor(seeded.projectId)).length, 1);
  assert.equal(slack.mock.callCount(), 1);
});

test("leaves a cut-over project's bot mentions to its new workspace", async () => {
  const slack = mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const seeded = await seedSlackProject(new Date());

  await mention(seeded);

  assert.equal((await chatsFor(seeded.projectId)).length, 0);
  assert.equal(slack.mock.callCount(), 0);
});

for (const [name, send] of [
  [
    "a follow-up offer for feedback",
    (incident: schema.Incident) => offerFollowUpForFeedback(feedbackOn(incident.id)),
  ],
  [
    "the resolved incident's root message update",
    (incident: schema.Incident) =>
      updateResolvedIncidentSlackRootMessage({
        incident: { id: incident.id, title: incident.title, service: null },
        text: "Resolved",
        blocks: [],
      }),
  ],
] as const) {
  test(`posts ${name} only while the project is not cut over`, async () => {
    const slack = mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
    const staying = await seedIncidentThread(await seedSlackProject());
    const moved = await seedIncidentThread(await seedSlackProject(new Date()));

    await send(staying);
    assert.equal(slack.mock.callCount(), 1);
    await send(moved);
    assert.equal(slack.mock.callCount(), 1);
  });
}
