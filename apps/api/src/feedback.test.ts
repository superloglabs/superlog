import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountFeedbackAuthed, mountFeedbackPublic } from "./feedback.js";

type Vars = { userId: string; orgId: string | null };

const orgIds: string[] = [];
const userIds: string[] = [];

before(async () => runMigrations());
after(async () => {
  try {
    for (const orgId of orgIds) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
    for (const userId of userIds) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  } finally {
    await closeDb();
  }
});

async function seedTenant() {
  const tag = `feedback-${randomUUID()}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("failed to seed org");
  orgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  if (!project) throw new Error("failed to seed project");
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("failed to seed user");
  userIds.push(user.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "member" });
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: project.id,
      service: "checkout",
      environment: "production",
      title: "Checkout failing",
      codename: "feedback-test",
      firstSeen: new Date(),
      lastSeen: new Date(),
    })
    .returning();
  if (!incident) throw new Error("failed to seed incident");
  return { org, project, user, incident };
}

function appFor(userId: string, orgId: string) {
  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", userId);
    c.set("orgId", orgId);
    return next();
  });
  mountFeedbackAuthed(app);
  return app;
}

function postFeedback(app: ReturnType<typeof appFor>, payload: Record<string, unknown>) {
  return app.request("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "the agent got this wrong", ...payload }),
  });
}

async function feedbackRowsFor(refId: string) {
  return db.select().from(schema.feedback).where(eq(schema.feedback.refId, refId));
}

test("records feedback on an incident in the caller's project", async () => {
  const { org, project, user, incident } = await seedTenant();

  const res = await postFeedback(appFor(user.id, org.id), {
    kind: "incident",
    refId: incident.id,
    projectId: project.id,
  });

  assert.equal(res.status, 200);
  const [row] = await feedbackRowsFor(incident.id);
  assert.equal(row?.projectId, project.id);
  assert.equal(row?.orgId, org.id);
  assert.equal(row?.authorUserId, user.id);
});

test("refuses feedback attributed to a project the caller cannot access", async () => {
  const attacker = await seedTenant();
  const victim = await seedTenant();

  const res = await postFeedback(appFor(attacker.user.id, attacker.org.id), {
    kind: "incident",
    refId: victim.incident.id,
    projectId: victim.project.id,
  });

  assert.equal(res.status, 404);
  assert.deepEqual(await feedbackRowsFor(victim.incident.id), []);
});

test("refuses feedback on another tenant's incident through the caller's own project", async () => {
  const attacker = await seedTenant();
  const victim = await seedTenant();

  const res = await postFeedback(appFor(attacker.user.id, attacker.org.id), {
    kind: "incident",
    refId: victim.incident.id,
    projectId: attacker.project.id,
  });

  assert.equal(res.status, 404);
  assert.deepEqual(await feedbackRowsFor(victim.incident.id), []);
});

test("refuses a reference that names no record", async () => {
  const { org, project, user } = await seedTenant();
  const app = appFor(user.id, org.id);

  for (const refId of [`not-a-uuid-${randomUUID()}`, randomUUID()]) {
    const res = await postFeedback(app, { kind: "incident", refId, projectId: project.id });

    assert.equal(res.status, 404);
    assert.deepEqual(await feedbackRowsFor(refId), []);
  }
});

test("requires a project", async () => {
  const { org, user, incident } = await seedTenant();

  const res = await postFeedback(appFor(user.id, org.id), {
    kind: "incident",
    refId: incident.id,
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await feedbackRowsFor(incident.id), []);
});

test("a demo-overlaid project can report on the demo record it was shown", async () => {
  const viewer = await seedTenant();
  const demo = await seedTenant();
  const previousDemoProject = process.env.DEMO_PROJECT_ID;
  process.env.DEMO_PROJECT_ID = demo.project.id;

  try {
    const res = await postFeedback(appFor(viewer.user.id, viewer.org.id), {
      kind: "incident",
      refId: demo.incident.id,
      projectId: viewer.project.id,
    });

    assert.equal(res.status, 200);
    const [row] = await feedbackRowsFor(demo.incident.id);
    assert.equal(row?.projectId, viewer.project.id);
    assert.equal(row?.orgId, viewer.org.id);
  } finally {
    if (previousDemoProject === undefined) Reflect.deleteProperty(process.env, "DEMO_PROJECT_ID");
    else process.env.DEMO_PROJECT_ID = previousDemoProject;
  }
});

test("anonymous submissions cannot inject Slack markup into the team notification", async () => {
  const previousWebhook = process.env.FEEDBACK_SLACK_WEBHOOK;
  const previousFetch = globalThis.fetch;
  process.env.FEEDBACK_SLACK_WEBHOOK = "https://hooks.slack.test/feedback";
  let notified: () => void = () => {};
  const delivered = new Promise<void>((resolve) => {
    notified = resolve;
  });
  let posted = "";
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    posted = JSON.parse(String(init?.body)).text;
    notified();
    return new Response("ok");
  }) as typeof fetch;

  try {
    const app = new Hono();
    mountFeedbackPublic(app);
    const owner = `<!here>${randomUUID()}`;

    const res = await app.request(`/feedback/pr/${encodeURIComponent(owner)}/repo/1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "<!channel> urgent <https://evil.test|Open in admin>",
        githubLogin: "<@U123>",
      }),
    });
    assert.equal(res.status, 200);
    await delivered;

    assert.doesNotMatch(posted, /<!channel>|<!here>|<@U123>|<https:\/\/evil\.test/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWebhook === undefined) {
      Reflect.deleteProperty(process.env, "FEEDBACK_SLACK_WEBHOOK");
    } else process.env.FEEDBACK_SLACK_WEBHOOK = previousWebhook;
  }
});
