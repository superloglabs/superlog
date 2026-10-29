import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, mock, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
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
  return { channelId, projectId: project.id, teamId };
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
