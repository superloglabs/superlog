import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { symmetricDecrypt } from "better-auth/crypto";
import type { DB } from "./client.js";
import {
  hydrateLinearInstallation,
  hydrateNotionInstallation,
  hydrateSlackInstallation,
  hydrateWebhookEndpoint,
} from "./credential-storage.js";
import * as schema from "./schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const {
  backfillCredentialStorage,
  eraseLegacyPlaintextCredentials,
  inspectCredentialStorage,
  parseCredentialMigrationOperation,
} = await import("./credential-migration.js");
const { findActiveLinearInstallationByWebhookId } = await import("./linear.js");

test("backfills every recoverable plaintext credential before erasing legacy values", async () => {
  const originalAgentKey = process.env.AGENT_SECRETS_KEY;
  const originalAuthSecret = process.env.BETTER_AUTH_SECRET;
  const originalMode = process.env.CREDENTIAL_STORAGE_MODE;
  process.env.AGENT_SECRETS_KEY = randomBytes(32).toString("base64");
  process.env.BETTER_AUTH_SECRET = "migration-test-auth-secret";
  process.env.CREDENTIAL_STORAGE_MODE = "dual-write";

  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });

  try {
    const [org] = await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning();
    assert.ok(org);
    const [project] = await db
      .insert(schema.projects)
      .values({ orgId: org.id, name: "App", slug: "app" })
      .returning();
    assert.ok(project);
    const [user] = await db
      .insert(schema.users)
      .values({ email: "owner@example.com", name: "Owner" })
      .returning();
    assert.ok(user);

    await Promise.all([
      db.insert(schema.accounts).values({
        userId: user.id,
        accountId: "provider-account",
        providerId: "google",
        accessToken: "social-access",
        refreshToken: "social-refresh",
        idToken: "social-id-token",
      }),
      db.insert(schema.slackInstallations).values({
        projectId: project.id,
        teamId: "team",
        botAccessToken: "slack-token",
      }),
      db.insert(schema.linearInstallations).values({
        projectId: project.id,
        workspaceId: "linear-workspace",
        accessToken: "linear-access",
        refreshToken: "linear-refresh",
        webhookSecret: "linear-webhook",
      }),
      db.insert(schema.notionInstallations).values({
        projectId: project.id,
        botId: "notion-bot",
        workspaceId: "notion-workspace",
        accessToken: "notion-access",
      }),
      db.insert(schema.webhookEndpoints).values({
        projectId: project.id,
        url: "https://example.com/webhook",
        secret: "webhook-secret",
      }),
    ]);

    assert.equal((await inspectCredentialStorage(db)).unprotectedValues, 9);
    await backfillCredentialStorage(db);

    const afterBackfill = await inspectCredentialStorage(db);
    assert.equal(afterBackfill.unprotectedValues, 0);
    assert.equal(afterBackfill.plaintextValues, 6);

    const account = await db.query.accounts.findFirst();
    assert.ok(account?.accessToken);
    assert.equal(
      await symmetricDecrypt({ key: process.env.BETTER_AUTH_SECRET, data: account.accessToken }),
      "social-access",
    );
    assert.equal(account.idToken, null);

    await assert.rejects(
      eraseLegacyPlaintextCredentials(db),
      /until CREDENTIAL_STORAGE_MODE="encrypted-only" is deployed/,
    );
    process.env.CREDENTIAL_STORAGE_MODE = "encrypted-only";

    await db
      .update(schema.accounts)
      .set({ accessToken: "late-plaintext-token", updatedAt: new Date() })
      .where(eq(schema.accounts.id, account.id));
    await assert.rejects(
      eraseLegacyPlaintextCredentials(db),
      /refusing to erase 1 unprotected credential value/,
    );
    await backfillCredentialStorage(db);
    await eraseLegacyPlaintextCredentials(db);

    const [brokenSlack] = await db
      .insert(schema.slackInstallations)
      .values({
        projectId: project.id,
        teamId: "broken-team",
        botAccessToken: null,
      })
      .returning();
    assert.ok(brokenSlack);
    await assert.rejects(
      eraseLegacyPlaintextCredentials(db),
      /refusing to erase 1 unprotected credential value/,
    );
    await db
      .update(schema.slackInstallations)
      .set({ revokedAt: new Date() })
      .where(eq(schema.slackInstallations.id, brokenSlack.id));
    await db.insert(schema.linearInstallations).values({
      projectId: project.id,
      workspaceId: "revoked-linear-workspace",
      accessToken: null,
      webhookId: "revoked-linear-webhook",
      revokedAt: new Date(),
    });
    await backfillCredentialStorage(db);
    assert.equal(
      await findActiveLinearInstallationByWebhookId("revoked-linear-webhook", db),
      null,
    );

    await eraseLegacyPlaintextCredentials(db);
    assert.equal((await inspectCredentialStorage(db)).plaintextValues, 0);

    const slack = await db.query.slackInstallations.findFirst();
    const linear = await db.query.linearInstallations.findFirst();
    const notion = await db.query.notionInstallations.findFirst();
    const webhook = await db.query.webhookEndpoints.findFirst();
    assert.ok(slack && linear && notion && webhook);
    assert.equal(hydrateSlackInstallation(slack).botAccessToken, "slack-token");
    assert.equal(hydrateLinearInstallation(linear).refreshToken, "linear-refresh");
    assert.equal(hydrateNotionInstallation(notion).accessToken, "notion-access");
    assert.equal(hydrateWebhookEndpoint(webhook).secret, "webhook-secret");
  } finally {
    await client.close();
    restoreEnv("AGENT_SECRETS_KEY", originalAgentKey);
    restoreEnv("BETTER_AUTH_SECRET", originalAuthSecret);
    restoreEnv("CREDENTIAL_STORAGE_MODE", originalMode);
  }
});

test("credential migration operations accept documented names and reject ambiguity", () => {
  assert.equal(parseCredentialMigrationOperation([]), "inspect");
  assert.equal(parseCredentialMigrationOperation(["inspect"]), "inspect");
  assert.equal(parseCredentialMigrationOperation(["backfill"]), "backfill");
  assert.equal(parseCredentialMigrationOperation(["--backfill"]), "backfill");
  assert.equal(parseCredentialMigrationOperation(["erase-plaintext"]), "erase-plaintext");
  assert.equal(parseCredentialMigrationOperation(["--erase-plaintext"]), "erase-plaintext");
  assert.throws(() => parseCredentialMigrationOperation(["unknown"]), /unknown operation/);
  assert.throws(
    () => parseCredentialMigrationOperation(["backfill", "erase-plaintext"]),
    /exactly one operation/,
  );
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}
