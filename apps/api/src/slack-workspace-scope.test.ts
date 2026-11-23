import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, mock, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { offerFollowUpForFeedback } from "./follow-up-offer.js";
import {
  type SlackInteractivityPayload,
  handleSlackBlockActions,
  handleSlackEventEnvelope,
  mountSlackAuthed,
} from "./slack.js";

const orgIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  await runMigrations();
});

afterEach(() => {
  mock.restoreAll();
});

after(async () => {
  try {
    for (const orgId of orgIds) await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    for (const userId of userIds) await db.delete(schema.users).where(eq(schema.users.id, userId));
  } finally {
    await closeDb();
  }
});

function tag() {
  return randomBytes(4).toString("hex");
}

async function seedOrg() {
  const t = tag();
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: `acme-${t}`, slug: `acme-${t}` })
    .returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `owner-${t}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  userIds.push(user.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  return { org, user };
}

async function seedSlackProject(input: {
  orgId: string;
  teamId: string;
  channelId?: string;
  createdAt?: Date;
}) {
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: input.orgId, name: "Default", slug: `p-${tag()}` })
    .returning();
  if (!project) throw new Error("seed project failed");
  const [installation] = await db
    .insert(schema.slackInstallations)
    .values({
      projectId: project.id,
      teamId: input.teamId,
      botUserId: "UBOT",
      botAccessToken: `xoxb-${tag()}`,
      channelId: input.channelId ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning();
  if (!installation) throw new Error("seed installation failed");
  return { project, installation };
}

async function seedIncidentThread(input: {
  projectId: string;
  installationId: string | null;
  channelId: string;
}) {
  const now = new Date();
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: input.projectId,
      title: "Checkout failing",
      firstSeen: now,
      lastSeen: now,
      slackChannelId: input.channelId,
      slackThreadTs: `1700000000.${tag()}`,
      slackInstallationId: input.installationId,
    })
    .returning();
  if (!incident) throw new Error("seed incident failed");
  await db
    .insert(schema.agentRuns)
    .values({ incidentId: incident.id, state: "complete", completedAt: now });
  return incident;
}

function click(actionId: string, teamId: string): SlackInteractivityPayload {
  return {
    type: "block_actions",
    team: { id: teamId },
    user: { id: "UCLICK", name: "someone" },
    actions: [{ action_id: actionId, action_ts: `${Date.now()}.${tag()}` }],
  };
}

async function incidentStatus(id: string) {
  const row = await db.query.incidents.findFirst({ where: eq(schema.incidents.id, id) });
  return row?.status;
}

test("Slack buttons act only on incidents of the workspace that clicked them", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const { org } = await seedOrg();
  const teamId = `T${tag()}`;
  const otherTeamId = `T${tag()}`;
  const { project, installation } = await seedSlackProject({ orgId: org.id, teamId });
  const pinned = await seedIncidentThread({
    projectId: project.id,
    installationId: installation.id,
    channelId: "CINC",
  });
  const unpinned = await seedIncidentThread({
    projectId: project.id,
    installationId: null,
    channelId: "CINC",
  });

  for (const incident of [pinned, unpinned]) {
    await handleSlackBlockActions(click(`resolve_incident:${incident.id}`, otherTeamId));
    assert.equal(await incidentStatus(incident.id), "open");
    await handleSlackBlockActions(click(`resolve_incident:${incident.id}`, teamId));
    assert.equal(await incidentStatus(incident.id), "resolved");
  }
});

test("Slack buttons do nothing once the workspace's installation is revoked", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const { org } = await seedOrg();
  const teamId = `T${tag()}`;
  const { project, installation } = await seedSlackProject({ orgId: org.id, teamId });
  const pinned = await seedIncidentThread({
    projectId: project.id,
    installationId: installation.id,
    channelId: "CINC",
  });
  const unpinned = await seedIncidentThread({
    projectId: project.id,
    installationId: null,
    channelId: "CINC",
  });
  await db
    .update(schema.slackInstallations)
    .set({ revokedAt: new Date() })
    .where(eq(schema.slackInstallations.id, installation.id));

  for (const incident of [pinned, unpinned]) {
    await handleSlackBlockActions(click(`resolve_incident:${incident.id}`, teamId));
    assert.equal(await incidentStatus(incident.id), "open");
  }
});

test("concurrent default-chat updates leave one default per org and workspace", async () => {
  const teamId = `T${tag()}`;
  const owner = await seedOrg();
  const projects = await Promise.all(
    Array.from({ length: 4 }, () => seedSlackProject({ orgId: owner.org.id, teamId })),
  );
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("*", (c, next) => {
    c.set("userId", owner.user.id);
    c.set("orgId", owner.org.id);
    return next();
  });
  mountSlackAuthed(app);

  for (let round = 0; round < 5; round++) {
    const responses = await Promise.all(
      projects.map(({ project }) =>
        app.request(`/api/projects/${project.id}/slack-chat-default`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
      ),
    );
    for (const res of responses) assert.equal(res.status, 200);
    const defaults = await db.query.slackInstallations.findMany({
      where: eq(schema.slackInstallations.teamId, teamId),
    });
    assert.equal(defaults.filter((row) => row.isDefaultChatProject).length, 1);
  }
});

test("a follow-up click never runs feedback from an anonymous PR link", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const { org } = await seedOrg();
  const teamId = `T${tag()}`;
  const { project, installation } = await seedSlackProject({ orgId: org.id, teamId });
  const incident = await seedIncidentThread({
    projectId: project.id,
    installationId: installation.id,
    channelId: "CINC",
  });
  const seedFeedback = async (source: schema.FeedbackSource) => {
    const [row] = await db
      .insert(schema.feedback)
      .values({ kind: "incident", refId: incident.id, source, body: "look at the cache too" })
      .returning();
    if (!row) throw new Error("seed feedback failed");
    return row;
  };
  const runCount = async () =>
    (await db.query.agentRuns.findMany({ where: eq(schema.agentRuns.incidentId, incident.id) }))
      .length;

  const anonymous = await seedFeedback("pr_link");
  await handleSlackBlockActions(click(`follow_up_confirm:${anonymous.id}`, teamId));
  assert.equal(await runCount(), 1);

  const fromDialog = await seedFeedback("dialog");
  await handleSlackBlockActions(click(`follow_up_confirm:${fromDialog.id}`, teamId));
  assert.equal(await runCount(), 2);
});

test("PR-link feedback is offered in Slack only when an org member wrote it", async () => {
  const slack = mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const { org, user: member } = await seedOrg();
  const { user: outsider } = await seedOrg();
  const { project, installation } = await seedSlackProject({ orgId: org.id, teamId: `T${tag()}` });
  const incident = await seedIncidentThread({
    projectId: project.id,
    installationId: installation.id,
    channelId: "CINC",
  });
  const prLinkFeedback = (authorUserId: string | null) =>
    ({
      id: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0",
      kind: "incident",
      refId: incident.id,
      source: "pr_link",
      body: "the retry loop is the real cause",
      authorUserId,
    }) as schema.Feedback;

  await offerFollowUpForFeedback(prLinkFeedback(null));
  await offerFollowUpForFeedback(prLinkFeedback(outsider.id));
  assert.equal(slack.mock.callCount(), 0);

  await offerFollowUpForFeedback(prLinkFeedback(member.id));
  assert.equal(slack.mock.callCount(), 1);
});

test("a later org connecting the same Slack workspace does not take over chat routing", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const teamId = `T${tag()}`;
  const channelId = `C${tag()}`;
  const first = await seedOrg();
  const later = await seedOrg();
  const firstProject = await seedSlackProject({
    orgId: first.org.id,
    teamId,
    channelId,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const laterProject = await seedSlackProject({
    orgId: later.org.id,
    teamId,
    channelId,
    createdAt: new Date("2026-02-01T00:00:00Z"),
  });

  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("*", (c, next) => {
    c.set("userId", later.user.id);
    c.set("orgId", later.org.id);
    return next();
  });
  mountSlackAuthed(app);
  await db
    .update(schema.slackInstallations)
    .set({ isDefaultChatProject: true })
    .where(eq(schema.slackInstallations.id, firstProject.installation.id));

  const res = await app.request(`/api/projects/${laterProject.project.id}/slack-chat-default`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 200);
  const firstRow = await db.query.slackInstallations.findFirst({
    where: eq(schema.slackInstallations.id, firstProject.installation.id),
  });
  assert.equal(firstRow?.isDefaultChatProject, true);

  for (const channel of [channelId, `C${tag()}`]) {
    await handleSlackEventEnvelope({
      type: "event_callback",
      event_id: `Ev${tag()}`,
      team_id: teamId,
      event: {
        type: "message",
        text: "<@UBOT> why is checkout slow?",
        channel,
        user: "UHUMAN",
        ts: `1700000000.${tag()}`,
      },
    });
  }

  const chatsFor = (projectId: string) =>
    db.query.agentChats.findMany({ where: eq(schema.agentChats.projectId, projectId) });
  assert.equal((await chatsFor(firstProject.project.id)).length, 2);
  assert.equal((await chatsFor(laterProject.project.id)).length, 0);
});

test("chats routed to the first org reply through the workspace's newest bot token", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json({ ok: true, ts: "1700000000.000100" }),
  );
  const teamId = `T${tag()}`;
  const first = await seedOrg();
  const later = await seedOrg();
  const firstProject = await seedSlackProject({
    orgId: first.org.id,
    teamId,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const laterProject = await seedSlackProject({
    orgId: later.org.id,
    teamId,
    createdAt: new Date("2026-02-01T00:00:00Z"),
  });

  await handleSlackEventEnvelope({
    type: "event_callback",
    event_id: `Ev${tag()}`,
    team_id: teamId,
    event: {
      type: "app_mention",
      text: "<@UBOT> why is checkout slow?",
      channel: `C${tag()}`,
      user: "UHUMAN",
      ts: `1700000000.${tag()}`,
    },
  });

  const chats = await db.query.agentChats.findMany({
    where: eq(schema.agentChats.projectId, firstProject.project.id),
  });
  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.slackInstallationId, laterProject.installation.id);
  const tokens = fetchMock.mock.calls
    .filter((call) => String(call.arguments[0]).includes("chat.postMessage"))
    .map((call) => {
      const init = call.arguments[1] as RequestInit | undefined;
      return new Headers(init?.headers).get("authorization");
    });
  assert.ok(tokens.length > 0);
  assert.ok(tokens.every((t) => t === `Bearer ${laterProject.installation.botAccessToken}`));
});
