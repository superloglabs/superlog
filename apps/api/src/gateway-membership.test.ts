import "dotenv/config";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { closeDb, db, hashCliSession, runMigrations, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountGateway } from "./gateway.js";

const orgIds: string[] = [];
const userIds: string[] = [];

before(async () => runMigrations());
after(async () => {
  try {
    for (const orgId of orgIds) await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    for (const userId of userIds) await db.delete(schema.users).where(eq(schema.users.id, userId));
  } finally {
    await closeDb();
  }
});

test("a CLI session stops working once its user leaves the org", async () => {
  const tag = `gateway-${randomUUID()}`;
  const [org] = await db.insert(schema.orgs).values({ name: "Acme", slug: tag }).returning();
  if (!org) throw new Error("failed to seed org");
  orgIds.push(org.id);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("failed to seed user");
  userIds.push(user.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "member" });

  const token = `superlog_cli_${randomUUID()}`;
  await db.insert(schema.cliSessions).values({
    userId: user.id,
    orgId: org.id,
    tokenPrefix: token.slice(0, 16),
    tokenHash: hashCliSession(token),
    expiresAt: new Date(Date.now() + 60_000),
  });

  const app = new Hono();
  mountGateway(app, {} as ClickHouseClient);
  const me = () => app.request("/v1/me", { headers: { authorization: `Bearer ${token}` } });

  const asMember = await me();
  assert.equal(asMember.status, 200);
  assert.deepEqual(await asMember.json(), { user: user.email, org: "Acme" });

  await db
    .delete(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)));

  const afterRemoval = await me();
  assert.equal(afterRemoval.status, 401);
});
