import "dotenv/config";
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import {
  BLOCKED_AUTH_MUTATIONS,
  EMAIL_VERIFICATION_GRANDFATHER_CUTOFF,
  isAuthMutationBlockedForUnverified,
  isEmailVerificationExempt,
  isGrandfatheredUnverifiedUser,
  warnIfDefaultGrandfatherCutoff,
} from "./email-verification-gate.js";

const orgIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  await runMigrations();
});
after(async () => {
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
    for (const userId of userIds.reverse()) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  } finally {
    await closeDb();
  }
});

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function seedUser() {
  const tag = uniq("evg-user");
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  userIds.push(user.id);
  return user;
}

async function seedOrg() {
  const tag = uniq("evg-org");
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  return org;
}

test("GET /api/me is exempt, mutating and data routes are not", () => {
  assert.equal(isEmailVerificationExempt("GET", "/api/me"), true);
  assert.equal(isEmailVerificationExempt("POST", "/api/me/orgs"), false);
  assert.equal(isEmailVerificationExempt("GET", "/api/projects/p1/issues"), false);
  assert.equal(isEmailVerificationExempt("PATCH", "/api/projects/p1/incidents/i1"), false);
  assert.equal(isEmailVerificationExempt("GET", "/api/projects/p1/keys"), false);
});

test("user with no membership is not grandfathered", async () => {
  const user = await seedUser();
  assert.equal(await isGrandfatheredUnverifiedUser(user.id), false);
});

test("membership created before the cutoff is grandfathered", async () => {
  const user = await seedUser();
  const org = await seedOrg();
  await db.insert(schema.orgMembers).values({
    orgId: org.id,
    userId: user.id,
    role: "member",
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  assert.equal(await isGrandfatheredUnverifiedUser(user.id), true);
});

test("membership created after the cutoff is not grandfathered", async () => {
  const user = await seedUser();
  const org = await seedOrg();
  await db.insert(schema.orgMembers).values({
    orgId: org.id,
    userId: user.id,
    role: "member",
    createdAt: new Date(EMAIL_VERIFICATION_GRANDFATHER_CUTOFF.getTime() + 86_400_000),
  });
  assert.equal(await isGrandfatheredUnverifiedUser(user.id), false);
});

test("organization/admin mutations are blocked for unverified sessions", () => {
  // Pin the FULL deny set: this list is the only protection for /api/auth/*
  // mutations against unverified sessions, so any removal or addition must
  // fail here until the test is updated alongside the implementation.
  assert.deepEqual(
    [...BLOCKED_AUTH_MUTATIONS].sort(),
    [
      "/api/auth/admin/ban-user",
      "/api/auth/admin/impersonate-user",
      "/api/auth/admin/remove-user",
      "/api/auth/admin/set-role",
      "/api/auth/admin/unban-user",
      "/api/auth/change-email",
      "/api/auth/change-password",
      "/api/auth/delete-user",
      "/api/auth/organization/add-team-member",
      "/api/auth/organization/cancel-invitation",
      "/api/auth/organization/create",
      "/api/auth/organization/create-role",
      "/api/auth/organization/create-team",
      "/api/auth/organization/delete",
      "/api/auth/organization/delete-role",
      "/api/auth/organization/invite-member",
      "/api/auth/organization/leave",
      "/api/auth/organization/remove-member",
      "/api/auth/organization/remove-team",
      "/api/auth/organization/remove-team-member",
      "/api/auth/organization/set-active",
      "/api/auth/organization/set-active-team",
      "/api/auth/organization/update",
      "/api/auth/organization/update-member-role",
      "/api/auth/organization/update-role",
      "/api/auth/organization/update-team",
      "/api/auth/update-user",
    ].sort(),
  );
  for (const path of BLOCKED_AUTH_MUTATIONS) {
    assert.equal(isAuthMutationBlockedForUnverified(path), true, path);
  }
});

test("reads and invitation accept flows pass through to Better-Auth", () => {
  for (const path of [
    "/api/auth/get-session",
    "/api/auth/sign-out",
    "/api/auth/verify-email",
    "/api/auth/send-verification-email",
    "/api/auth/sign-in/email",
    "/api/auth/sign-up/email",
    "/api/auth/organization/get-invitation",
    "/api/auth/organization/accept-invitation",
    "/api/auth/organization/reject-invitation",
    "/api/auth/organization/list-members",
    "/api/auth/admin/stop-impersonating",
  ]) {
    assert.equal(isAuthMutationBlockedForUnverified(path), false, path);
  }
});

test("cutoff warning fires only when the env var is unset", () => {
  const seen: string[] = [];
  const hadEnv = process.env.EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO;
  delete process.env.EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO;
  try {
    warnIfDefaultGrandfatherCutoff((message) => seen.push(message));
    warnIfDefaultGrandfatherCutoff((message) => seen.push(message));
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? "", /EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO/);
  } finally {
    if (hadEnv !== undefined) process.env.EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO = hadEnv;
  }
});
