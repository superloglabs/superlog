import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { isProtectedBetterAuthToken, protectBetterAuthToken } from "./auth-credential-storage.js";
import { type DB, db as defaultDb } from "./client.js";
import {
  type StoredCredential,
  clearedLinearCredentialFields,
  clearedNotionCredentialFields,
  clearedSlackCredentialFields,
  credentialStorageMode,
  linearCredentialFields,
  notionCredentialFields,
  readStoredCredential,
  slackCredentialFields,
  storedCredentialNeedsProtection,
  webhookCredentialFields,
} from "./credential-storage.js";
import * as schema from "./schema.js";

export type CredentialMigrationReport = {
  plaintextValues: number;
  unprotectedValues: number;
  byStore: Record<"accounts" | "linear" | "notion" | "slack" | "webhooks", number>;
  unprotectedByStore: Record<"accounts" | "linear" | "notion" | "slack" | "webhooks", number>;
};

export type CredentialMigrationOperation = "inspect" | "backfill" | "erase-plaintext";

export function parseCredentialMigrationOperation(args: string[]): CredentialMigrationOperation {
  if (args.length > 1) throw new Error("expected exactly one operation");
  const operation = args[0] ?? "inspect";
  if (operation === "inspect") return "inspect";
  if (operation === "backfill" || operation === "--backfill") return "backfill";
  if (operation === "erase-plaintext" || operation === "--erase-plaintext") {
    return "erase-plaintext";
  }
  throw new Error(`unknown operation: ${operation}`);
}

function unprotected(
  plaintext: string | null,
  ciphertext: Buffer | null,
  nonce: Buffer | null,
  keyVersion: number | null,
  required: boolean,
): boolean {
  return storedCredentialNeedsProtection(
    storedCredential(plaintext, ciphertext, nonce, keyVersion),
    required,
  );
}

function storedCredential(
  plaintext: string | null,
  ciphertext: Buffer | null,
  nonce: Buffer | null,
  keyVersion: number | null,
): StoredCredential {
  return { plaintext, ciphertext, nonce, keyVersion };
}

function valueForBackfill(stored: StoredCredential, required: true): string;
function valueForBackfill(stored: StoredCredential, required: false): string | null;
function valueForBackfill(stored: StoredCredential, required: boolean): string | null {
  if (stored.plaintext !== null) return stored.plaintext;
  if (
    !required &&
    stored.ciphertext === null &&
    stored.nonce === null &&
    stored.keyVersion === null
  )
    return null;
  return readStoredCredential(stored);
}

function confirmUpdatedRow(rows: { id: string }[], store: string, expectedId: string): void {
  if (rows.length !== 1 || rows[0]?.id !== expectedId) {
    throw new Error(`failed to update ${store} credential ${expectedId}`);
  }
}

export async function inspectCredentialStorage(
  database: DB = defaultDb,
): Promise<CredentialMigrationReport> {
  const [accounts, linear, notion, slack, webhooks] = await Promise.all([
    database.query.accounts.findMany({
      where: and(
        ne(schema.accounts.providerId, "credential"),
        or(
          isNotNull(schema.accounts.accessToken),
          isNotNull(schema.accounts.refreshToken),
          isNotNull(schema.accounts.idToken),
        ),
      ),
      columns: { accessToken: true, refreshToken: true, idToken: true },
    }),
    database.query.linearInstallations.findMany(),
    database.query.notionInstallations.findMany(),
    database.query.slackInstallations.findMany(),
    database.query.webhookEndpoints.findMany(),
  ]);

  const accountTokens = accounts
    .flatMap((row) => [row.accessToken, row.refreshToken])
    .filter((value): value is string => value !== null);
  const idTokens = accounts.filter((row) => row.idToken !== null).length;
  const accountValues = accountTokens.length + idTokens;
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const unprotectedAccounts = betterAuthSecret
    ? (
        await Promise.all(
          accountTokens.map((token) => isProtectedBetterAuthToken(token, betterAuthSecret)),
        )
      ).filter((protectedToken) => !protectedToken).length + idTokens
    : accountValues;
  const linearPlaintext = linear
    .flatMap((row) => [row.accessToken, row.refreshToken, row.webhookSecret])
    .filter(Boolean).length;
  const notionPlaintext = notion.filter((row) => row.accessToken !== null).length;
  const slackPlaintext = slack.filter((row) => row.botAccessToken !== null).length;
  const webhookPlaintext = webhooks.filter((row) => row.secret !== null).length;

  const unprotectedLinear = linear.reduce(
    (count, row) =>
      count +
      (unprotected(
        row.accessToken,
        row.accessTokenCiphertext,
        row.accessTokenNonce,
        row.accessTokenKeyVersion,
        row.revokedAt === null,
      )
        ? 1
        : 0) +
      (unprotected(
        row.refreshToken,
        row.refreshTokenCiphertext,
        row.refreshTokenNonce,
        row.refreshTokenKeyVersion,
        false,
      )
        ? 1
        : 0) +
      (unprotected(
        row.webhookSecret,
        row.webhookSecretCiphertext,
        row.webhookSecretNonce,
        row.webhookSecretKeyVersion,
        false,
      )
        ? 1
        : 0),
    0,
  );
  const unprotectedNotion = notion.filter((row) =>
    unprotected(
      row.accessToken,
      row.accessTokenCiphertext,
      row.accessTokenNonce,
      row.accessTokenKeyVersion,
      row.revokedAt === null,
    ),
  ).length;
  const unprotectedSlack = slack.filter((row) =>
    unprotected(
      row.botAccessToken,
      row.botAccessTokenCiphertext,
      row.botAccessTokenNonce,
      row.botAccessTokenKeyVersion,
      row.revokedAt === null,
    ),
  ).length;
  const unprotectedWebhooks = webhooks.filter((row) =>
    unprotected(row.secret, row.secretCiphertext, row.secretNonce, row.secretKeyVersion, true),
  ).length;

  return {
    plaintextValues:
      unprotectedAccounts + linearPlaintext + notionPlaintext + slackPlaintext + webhookPlaintext,
    unprotectedValues:
      unprotectedAccounts +
      unprotectedLinear +
      unprotectedNotion +
      unprotectedSlack +
      unprotectedWebhooks,
    byStore: {
      accounts: unprotectedAccounts,
      linear: linearPlaintext,
      notion: notionPlaintext,
      slack: slackPlaintext,
      webhooks: webhookPlaintext,
    },
    unprotectedByStore: {
      accounts: unprotectedAccounts,
      linear: unprotectedLinear,
      notion: unprotectedNotion,
      slack: unprotectedSlack,
      webhooks: unprotectedWebhooks,
    },
  };
}

export async function backfillCredentialStorage(database: DB = defaultDb): Promise<void> {
  const [linear, notion, slack, webhooks, accounts] = await Promise.all([
    database.query.linearInstallations.findMany(),
    database.query.notionInstallations.findMany(),
    database.query.slackInstallations.findMany(),
    database.query.webhookEndpoints.findMany(),
    database.query.accounts.findMany({
      where: ne(schema.accounts.providerId, "credential"),
      columns: { id: true, accessToken: true, refreshToken: true, idToken: true },
    }),
  ]);

  for (const row of linear) {
    if (row.revokedAt) {
      const updated = await database
        .update(schema.linearInstallations)
        .set(clearedLinearCredentialFields)
        .where(
          and(
            eq(schema.linearInstallations.id, row.id),
            isNotNull(schema.linearInstallations.revokedAt),
          ),
        )
        .returning({ id: schema.linearInstallations.id });
      confirmUpdatedRow(updated, "Linear", row.id);
      continue;
    }
    const accessToken = storedCredential(
      row.accessToken,
      row.accessTokenCiphertext,
      row.accessTokenNonce,
      row.accessTokenKeyVersion,
    );
    const refreshToken = storedCredential(
      row.refreshToken,
      row.refreshTokenCiphertext,
      row.refreshTokenNonce,
      row.refreshTokenKeyVersion,
    );
    const webhookSecret = storedCredential(
      row.webhookSecret,
      row.webhookSecretCiphertext,
      row.webhookSecretNonce,
      row.webhookSecretKeyVersion,
    );
    const missingRequired = storedCredentialNeedsProtection(accessToken, true);
    const missingRefresh = storedCredentialNeedsProtection(refreshToken);
    const missingWebhook = storedCredentialNeedsProtection(webhookSecret);
    if (!missingRequired && !missingRefresh && !missingWebhook) continue;
    const updated = await database
      .update(schema.linearInstallations)
      .set(
        linearCredentialFields(
          {
            accessToken: valueForBackfill(accessToken, true),
            refreshToken: valueForBackfill(refreshToken, false),
            webhookSecret: valueForBackfill(webhookSecret, false),
          },
          "dual-write",
        ),
      )
      .where(
        and(
          eq(schema.linearInstallations.id, row.id),
          isNull(schema.linearInstallations.revokedAt),
        ),
      )
      .returning({ id: schema.linearInstallations.id });
    confirmUpdatedRow(updated, "Linear", row.id);
  }

  for (const row of notion) {
    if (row.revokedAt) {
      const updated = await database
        .update(schema.notionInstallations)
        .set(clearedNotionCredentialFields)
        .where(
          and(
            eq(schema.notionInstallations.id, row.id),
            isNotNull(schema.notionInstallations.revokedAt),
          ),
        )
        .returning({ id: schema.notionInstallations.id });
      confirmUpdatedRow(updated, "Notion", row.id);
      continue;
    }
    const accessToken = storedCredential(
      row.accessToken,
      row.accessTokenCiphertext,
      row.accessTokenNonce,
      row.accessTokenKeyVersion,
    );
    if (!storedCredentialNeedsProtection(accessToken, true)) continue;
    const updated = await database
      .update(schema.notionInstallations)
      .set(notionCredentialFields(valueForBackfill(accessToken, true), "dual-write"))
      .where(
        and(
          eq(schema.notionInstallations.id, row.id),
          isNull(schema.notionInstallations.revokedAt),
        ),
      )
      .returning({ id: schema.notionInstallations.id });
    confirmUpdatedRow(updated, "Notion", row.id);
  }

  for (const row of slack) {
    if (row.revokedAt) {
      const updated = await database
        .update(schema.slackInstallations)
        .set(clearedSlackCredentialFields)
        .where(
          and(
            eq(schema.slackInstallations.id, row.id),
            isNotNull(schema.slackInstallations.revokedAt),
          ),
        )
        .returning({ id: schema.slackInstallations.id });
      confirmUpdatedRow(updated, "Slack", row.id);
      continue;
    }
    const botAccessToken = storedCredential(
      row.botAccessToken,
      row.botAccessTokenCiphertext,
      row.botAccessTokenNonce,
      row.botAccessTokenKeyVersion,
    );
    if (!storedCredentialNeedsProtection(botAccessToken, true)) continue;
    const updated = await database
      .update(schema.slackInstallations)
      .set(slackCredentialFields(valueForBackfill(botAccessToken, true), "dual-write"))
      .where(
        and(eq(schema.slackInstallations.id, row.id), isNull(schema.slackInstallations.revokedAt)),
      )
      .returning({ id: schema.slackInstallations.id });
    confirmUpdatedRow(updated, "Slack", row.id);
  }

  for (const row of webhooks) {
    const secret = storedCredential(
      row.secret,
      row.secretCiphertext,
      row.secretNonce,
      row.secretKeyVersion,
    );
    if (!storedCredentialNeedsProtection(secret, true)) continue;
    const updated = await database
      .update(schema.webhookEndpoints)
      .set(webhookCredentialFields(valueForBackfill(secret, true), "dual-write"))
      .where(eq(schema.webhookEndpoints.id, row.id))
      .returning({ id: schema.webhookEndpoints.id });
    confirmUpdatedRow(updated, "webhook", row.id);
  }

  const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
  if (accounts.some((row) => row.accessToken || row.refreshToken) && !betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is required to backfill provider account tokens");
  }
  if (betterAuthSecret) {
    for (const row of accounts) {
      const accessToken = row.accessToken
        ? await protectBetterAuthToken(row.accessToken, betterAuthSecret)
        : null;
      const refreshToken = row.refreshToken
        ? await protectBetterAuthToken(row.refreshToken, betterAuthSecret)
        : null;
      if (
        accessToken === row.accessToken &&
        refreshToken === row.refreshToken &&
        row.idToken === null
      )
        continue;
      const updated = await database
        .update(schema.accounts)
        .set({ accessToken, refreshToken, idToken: null, updatedAt: new Date() })
        .where(eq(schema.accounts.id, row.id))
        .returning({ id: schema.accounts.id });
      confirmUpdatedRow(updated, "account", row.id);
    }
  }
}

export async function eraseLegacyPlaintextCredentials(database: DB = defaultDb): Promise<void> {
  if (credentialStorageMode() !== "encrypted-only") {
    throw new Error(
      'refusing to erase plaintext until CREDENTIAL_STORAGE_MODE="encrypted-only" is deployed',
    );
  }
  const report = await inspectCredentialStorage(database);
  // Account tokens remain non-null because their framework-native ciphertext
  // intentionally occupies the existing columns. Refuse connector plaintext
  // erasure until both those native values and every connector envelope are
  // protected, including writes that raced the mode rollout.
  if (report.unprotectedValues > 0) {
    throw new Error(
      `refusing to erase ${report.unprotectedValues} unprotected credential value(s)`,
    );
  }

  await database.transaction(async (tx) => {
    await tx
      .update(schema.linearInstallations)
      .set({ accessToken: null, refreshToken: null, webhookSecret: null });
    await tx.update(schema.notionInstallations).set({ accessToken: null });
    await tx.update(schema.slackInstallations).set({ botAccessToken: null });
    await tx.update(schema.webhookEndpoints).set({ secret: null });
  });
}
