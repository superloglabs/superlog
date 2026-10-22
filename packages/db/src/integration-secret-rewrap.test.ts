import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import { hydrateLinearInstallation, linearCredentialFields } from "./credential-storage.js";
import {
  ENCRYPTED_INTEGRATION_SECRET_COLUMNS,
  encryptedSecretColumnLabel,
} from "./integration-secret-columns.js";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "./integration-secrets.js";
import * as schema from "./schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { parseRewrapArgs, rewrapIntegrationSecrets, rewrapEncryptedSecretRow } = await import(
  "./integration-secret-rewrap.js"
);

const originalKey = process.env.AGENT_SECRETS_KEY;
const originalMode = process.env.CREDENTIAL_STORAGE_MODE;

afterEach(() => {
  restoreEnv("AGENT_SECRETS_KEY", originalKey);
  restoreEnv("CREDENTIAL_STORAGE_MODE", originalMode);
});

function key(): string {
  return randomBytes(32).toString("base64");
}

async function freshDb(): Promise<{ client: PGlite; db: DB }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  return { client, db };
}

async function seedProject(db: DB) {
  const [org] = await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning();
  assert.ok(org);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "App", slug: "app" })
    .returning();
  assert.ok(project);
  return { org, project };
}

/** Seeds one row in several encrypted tables, all written under the current env key. */
async function seedEncryptedRows(db: DB) {
  const { org, project } = await seedProject(db);
  process.env.CREDENTIAL_STORAGE_MODE = "encrypted-only";

  const [linear] = await db
    .insert(schema.linearInstallations)
    .values({
      projectId: project.id,
      workspaceId: "linear-workspace",
      ...linearCredentialFields({
        accessToken: "linear-access",
        refreshToken: null,
        webhookSecret: "linear-webhook",
      }),
    })
    .returning();
  assert.ok(linear);

  const access = encryptIntegrationSecret("sentry-access");
  const relay = encryptIntegrationSecret("sentry-relay");
  const [sentry] = await db
    .insert(schema.sentryInstallations)
    .values({
      projectId: project.id,
      sentryInstallationId: "sentry-install",
      organizationSlug: "acme",
      sentryProjectSlug: "app",
      accessTokenCiphertext: access.ciphertext,
      accessTokenNonce: access.nonce.toString("base64"),
      accessTokenKeyVersion: access.keyVersion,
      relayTokenCiphertext: relay.ciphertext,
      relayTokenNonce: relay.nonce.toString("base64"),
      relayTokenKeyVersion: relay.keyVersion,
    })
    .returning();
  assert.ok(sentry);

  const [integration] = await db
    .insert(schema.orgIntegrations)
    .values({ orgId: org.id, slug: "custom" })
    .returning();
  assert.ok(integration);
  const orgSecret = encryptIntegrationSecret("org-secret");
  const [secret] = await db
    .insert(schema.orgIntegrationSecrets)
    .values({
      orgIntegrationId: integration.id,
      secretName: "API_TOKEN",
      ciphertext: orgSecret.ciphertext,
      nonce: orgSecret.nonce,
      keyVersion: orgSecret.keyVersion,
    })
    .returning();
  assert.ok(secret);

  const cfAccess = encryptIntegrationSecret("cloudflare-access");
  const cfIngest = encryptIntegrationSecret("cloudflare-ingest");
  const [cloudflare] = await db
    .insert(schema.cloudflareInstallations)
    .values({
      projectId: project.id,
      accountId: "cf-account",
      accessTokenCiphertext: cfAccess.ciphertext,
      accessTokenNonce: cfAccess.nonce,
      accessTokenKeyVersion: cfAccess.keyVersion,
      ingestKeyCiphertext: cfIngest.ciphertext,
      ingestKeyNonce: cfIngest.nonce,
      // Envelopes written before versions were recorded are version 1.
      ingestKeyKeyVersion: null,
    })
    .returning();
  assert.ok(cloudflare);

  return { linear, sentry, secret, cloudflare };
}

function totals(report: Awaited<ReturnType<typeof rewrapIntegrationSecrets>>) {
  return report.totals;
}

function columnReport(report: Awaited<ReturnType<typeof rewrapIntegrationSecrets>>, label: string) {
  const entry = report.columns.find((column) => column.column === label);
  assert.ok(entry, `missing report entry for ${label}`);
  return entry;
}

test("every *_key_version column in the schema is covered by the rewrap registry", () => {
  const covered = new Set(ENCRYPTED_INTEGRATION_SECRET_COLUMNS.map(encryptedSecretColumnLabel));
  const inSchema: string[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    for (const column of config.columns) {
      if (column.name.endsWith("key_version")) inSchema.push(`${config.name}.${column.name}`);
    }
  }

  assert.ok(inSchema.length > 0);
  const missing = inSchema.filter((label) => !covered.has(label));
  assert.deepEqual(
    missing,
    [],
    "add every new encrypted column to ENCRYPTED_INTEGRATION_SECRET_COLUMNS so key rotation re-encrypts it",
  );
  assert.equal(
    covered.size,
    ENCRYPTED_INTEGRATION_SECRET_COLUMNS.length,
    "duplicate registry entry",
  );
  assert.deepEqual([...covered].sort(), [...inSchema].sort());
});

test("every registry entry points at one table's id, ciphertext, nonce and key version", () => {
  for (const entry of ENCRYPTED_INTEGRATION_SECRET_COLUMNS) {
    const config = getTableConfig(entry.table);
    const label = encryptedSecretColumnLabel(entry);
    for (const column of [entry.id, entry.ciphertext, entry.nonce, entry.keyVersion]) {
      assert.ok(config.columns.includes(column), `${label}: ${column.name} is from another table`);
    }
    assert.equal(entry.id.primary, true, `${label}: id must be the primary key`);
    assert.equal(entry.ciphertext.getSQLType(), "bytea", `${label}: ciphertext must be bytea`);
    assert.equal(
      entry.nonce.getSQLType(),
      entry.nonceEncoding === "base64-text" ? "text" : "bytea",
      `${label}: nonce encoding does not match the column type`,
    );
    assert.equal(entry.keyVersion.getSQLType(), "integer", `${label}: key version must be integer`);
  }
});

test("rewrap moves version 1 envelopes to the current version and is idempotent", async () => {
  const k1 = key();
  const k2 = key();
  process.env.AGENT_SECRETS_KEY = k1;
  const { client, db } = await freshDb();
  try {
    const seeded = await seedEncryptedRows(db);

    process.env.AGENT_SECRETS_KEY = `2:${k2},1:${k1}`;

    const dryRun = await rewrapIntegrationSecrets(db, { dryRun: true, batchSize: 2 });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.currentVersion, 2);
    assert.deepEqual(totals(dryRun), {
      pending: 7,
      rewrapped: 7,
      conflicts: 0,
      failed: 0,
      remaining: 7,
    });
    assert.equal(dryRun.columns.length, ENCRYPTED_INTEGRATION_SECRET_COLUMNS.length);
    assert.deepEqual(columnReport(dryRun, "linear_installations.access_token_key_version"), {
      table: "linear_installations",
      column: "linear_installations.access_token_key_version",
      pending: 1,
      pendingByVersion: { "1": 1 },
      rewrapped: 1,
      conflicts: 0,
      failed: 0,
      remaining: 1,
    });
    assert.deepEqual(
      columnReport(dryRun, "cloudflare_installations.ingest_key_key_version").pendingByVersion,
      { legacy_null: 1 },
    );
    assert.equal(columnReport(dryRun, "linear_installations.refresh_token_key_version").pending, 0);
    const untouched = await db.query.linearInstallations.findFirst();
    assert.equal(untouched?.accessTokenKeyVersion, 1);
    assert.deepEqual(untouched?.accessTokenCiphertext, seeded.linear.accessTokenCiphertext);

    const run = await rewrapIntegrationSecrets(db, { dryRun: false, batchSize: 2 });
    assert.deepEqual(totals(run), {
      pending: 7,
      rewrapped: 7,
      conflicts: 0,
      failed: 0,
      remaining: 0,
    });

    // Only the new key remains: every value must still read back.
    process.env.AGENT_SECRETS_KEY = `2:${k2}`;
    const linear = await db.query.linearInstallations.findFirst();
    const sentry = await db.query.sentryInstallations.findFirst();
    const secret = await db.query.orgIntegrationSecrets.findFirst();
    const cloudflare = await db.query.cloudflareInstallations.findFirst();
    assert.ok(linear && sentry && secret && cloudflare);

    const hydrated = hydrateLinearInstallation(linear);
    assert.equal(hydrated.accessToken, "linear-access");
    assert.equal(hydrated.refreshToken, null);
    assert.equal(hydrated.webhookSecret, "linear-webhook");
    assert.equal(linear.refreshTokenKeyVersion, null);
    assert.equal(linear.refreshTokenCiphertext, null);
    assert.equal(sentry.accessTokenKeyVersion, 2);
    assert.equal(
      decryptIntegrationSecret({
        ciphertext: sentry.relayTokenCiphertext,
        nonce: Buffer.from(sentry.relayTokenNonce, "base64"),
        keyVersion: sentry.relayTokenKeyVersion,
      }),
      "sentry-relay",
    );
    assert.equal(
      decryptIntegrationSecret({
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        keyVersion: secret.keyVersion,
      }),
      "org-secret",
    );
    assert.equal(cloudflare.ingestKeyKeyVersion, 2);
    assert.ok(cloudflare.ingestKeyNonce);
    assert.equal(
      decryptIntegrationSecret({
        ciphertext: cloudflare.ingestKeyCiphertext as Buffer,
        nonce: cloudflare.ingestKeyNonce,
        keyVersion: 2,
      }),
      "cloudflare-ingest",
    );

    const again = await rewrapIntegrationSecrets(db, { dryRun: false });
    assert.deepEqual(totals(again), {
      pending: 0,
      rewrapped: 0,
      conflicts: 0,
      failed: 0,
      remaining: 0,
    });
  } finally {
    await client.close();
  }
});

test("rewrap reports undecryptable rows, keeps going, and leaves them untouched", async () => {
  const k1 = key();
  process.env.AGENT_SECRETS_KEY = k1;
  const { client, db } = await freshDb();
  try {
    const seeded = await seedEncryptedRows(db);
    const corrupt = Buffer.from(seeded.secret.ciphertext);
    corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
    await db
      .update(schema.orgIntegrationSecrets)
      .set({ ciphertext: corrupt })
      .where(eq(schema.orgIntegrationSecrets.id, seeded.secret.id));

    process.env.AGENT_SECRETS_KEY = `2:${key()},1:${k1}`;
    const dryRun = await rewrapIntegrationSecrets(db, { dryRun: true });
    assert.equal(dryRun.totals.failed, 1);
    assert.deepEqual(dryRun.failures, [
      {
        column: "org_integration_secrets.key_version",
        id: seeded.secret.id,
        keyVersion: 1,
        reason: dryRun.failures[0]?.reason,
      },
    ]);

    const run = await rewrapIntegrationSecrets(db, { dryRun: false });
    assert.equal(run.totals.rewrapped, 6);
    assert.equal(run.totals.failed, 1);
    assert.equal(run.totals.remaining, 1);
    const secret = await db.query.orgIntegrationSecrets.findFirst();
    assert.equal(secret?.keyVersion, 1);
    assert.ok(secret && Buffer.from(secret.ciphertext).equals(corrupt));
    for (const failure of run.failures) {
      assert.ok(!failure.reason.includes("org-secret"));
    }
  } finally {
    await client.close();
  }
});

test("rewrap reports rows whose key version is not in the keyring", async () => {
  const k1 = key();
  process.env.AGENT_SECRETS_KEY = k1;
  const { client, db } = await freshDb();
  try {
    await seedEncryptedRows(db);
    process.env.AGENT_SECRETS_KEY = `3:${key()},2:${key()}`;

    const dryRun = await rewrapIntegrationSecrets(db, { dryRun: true });

    assert.equal(dryRun.totals.pending, 7);
    assert.equal(dryRun.totals.failed, 7);
    assert.match(dryRun.failures[0]?.reason ?? "", /key version 1 is not configured/);
    assert.ok(!JSON.stringify(dryRun).includes(k1));
  } finally {
    await client.close();
  }
});

test("a concurrent write between read and rewrap wins over the stale re-encryption", async () => {
  const k1 = key();
  process.env.AGENT_SECRETS_KEY = k1;
  const { client, db } = await freshDb();
  try {
    const seeded = await seedEncryptedRows(db);
    const entry = ENCRYPTED_INTEGRATION_SECRET_COLUMNS.find(
      (column) => encryptedSecretColumnLabel(column) === "org_integration_secrets.key_version",
    );
    assert.ok(entry);
    const stale = {
      id: seeded.secret.id,
      ciphertext: seeded.secret.ciphertext,
      nonce: seeded.secret.nonce,
      keyVersion: seeded.secret.keyVersion,
    };

    // Another writer (e.g. an older task still encrypting with version 1)
    // replaces the secret after the rewrap read the row.
    const replacement = encryptIntegrationSecret("org-secret-rotated-by-user");
    await db
      .update(schema.orgIntegrationSecrets)
      .set({ ciphertext: replacement.ciphertext, nonce: replacement.nonce, keyVersion: 1 })
      .where(eq(schema.orgIntegrationSecrets.id, seeded.secret.id));

    process.env.AGENT_SECRETS_KEY = `2:${key()},1:${k1}`;
    const outcome = await rewrapEncryptedSecretRow(db, entry, stale);
    assert.equal(outcome, "conflict");

    const secret = await db.query.orgIntegrationSecrets.findFirst();
    assert.ok(secret);
    assert.equal(secret.keyVersion, 1);
    assert.equal(
      decryptIntegrationSecret({
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        keyVersion: secret.keyVersion,
      }),
      "org-secret-rotated-by-user",
    );

    const run = await rewrapIntegrationSecrets(db, { dryRun: false });
    assert.equal(run.totals.failed, 0);
    assert.equal(run.totals.remaining, 0);
  } finally {
    await client.close();
  }
});

test("rewrap arguments accept only --dry-run and --batch-size", () => {
  assert.deepEqual(parseRewrapArgs([]), { dryRun: false, batchSize: 100 });
  assert.deepEqual(parseRewrapArgs(["--dry-run"]), { dryRun: true, batchSize: 100 });
  assert.deepEqual(parseRewrapArgs(["--batch-size=10", "--dry-run"]), {
    dryRun: true,
    batchSize: 10,
  });
  assert.throws(() => parseRewrapArgs(["--batch-size=0"]), /batch size/);
  assert.throws(() => parseRewrapArgs(["--force"]), /unknown argument/);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}
