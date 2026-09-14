import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { isProtectedBetterAuthToken, protectBetterAuthToken } from "./auth-credential-storage.js";
import { type DB, db as defaultDb } from "./client.js";
import {
  clearedLinearCredentialFields,
  clearedNotionCredentialFields,
  clearedSlackCredentialFields,
  credentialStorageMode,
  hydrateLinearInstallation,
  hydrateNotionInstallation,
  hydrateSlackInstallation,
  hydrateWebhookEndpoint,
  linearCredentialFields,
  notionCredentialFields,
  slackCredentialFields,
  webhookCredentialFields,
} from "./credential-storage.js";
import * as schema from "./schema.js";

export type CredentialMigrationReport = {
  plaintextValues: number;
  unprotectedValues: number;
  byStore: Record<"accounts" | "linear" | "notion" | "slack" | "webhooks", number>;
  unprotectedByStore: Record<"accounts" | "linear" | "notion" | "slack" | "webhooks", number>;
};

function complete(ciphertext: Buffer | null, nonce: Buffer | null, keyVersion: number | null) {
  return ciphertext !== null && nonce !== null && keyVersion !== null;
}

function unprotected(
  plaintext: string | null,
  ciphertext: Buffer | null,
  nonce: Buffer | null,
  keyVersion: number | null,
  required: boolean,
): boolean {
  const hasAnyValue =
    required || plaintext !== null || ciphertext !== null || nonce !== null || keyVersion !== null;
  return hasAnyValue && !complete(ciphertext, nonce, keyVersion);
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
      columns: { id: true, accessToken: true, refreshToken: true, idToken: true, updatedAt: true },
    }),
  ]);

  for (const row of linear) {
    if (row.revokedAt) {
      await database
        .update(schema.linearInstallations)
        .set(clearedLinearCredentialFields)
        .where(
          and(
            eq(schema.linearInstallations.id, row.id),
            eq(schema.linearInstallations.updatedAt, row.updatedAt),
            eq(schema.linearInstallations.revokedAt, row.revokedAt),
          ),
        );
      continue;
    }
    const missingRequired = !complete(
      row.accessTokenCiphertext,
      row.accessTokenNonce,
      row.accessTokenKeyVersion,
    );
    const missingRefresh =
      row.refreshToken !== null &&
      !complete(row.refreshTokenCiphertext, row.refreshTokenNonce, row.refreshTokenKeyVersion);
    const missingWebhook =
      row.webhookSecret !== null &&
      !complete(row.webhookSecretCiphertext, row.webhookSecretNonce, row.webhookSecretKeyVersion);
    if (!missingRequired && !missingRefresh && !missingWebhook) continue;
    const credential = hydrateLinearInstallation(row);
    await database
      .update(schema.linearInstallations)
      .set(
        linearCredentialFields(
          {
            accessToken: credential.accessToken,
            refreshToken: credential.refreshToken,
            webhookSecret: credential.webhookSecret,
          },
          "dual-write",
        ),
      )
      .where(
        and(
          eq(schema.linearInstallations.id, row.id),
          eq(schema.linearInstallations.updatedAt, row.updatedAt),
          isNull(schema.linearInstallations.revokedAt),
        ),
      );
  }

  for (const row of notion) {
    if (row.revokedAt) {
      await database
        .update(schema.notionInstallations)
        .set(clearedNotionCredentialFields)
        .where(
          and(
            eq(schema.notionInstallations.id, row.id),
            eq(schema.notionInstallations.updatedAt, row.updatedAt),
            eq(schema.notionInstallations.revokedAt, row.revokedAt),
          ),
        );
      continue;
    }
    if (complete(row.accessTokenCiphertext, row.accessTokenNonce, row.accessTokenKeyVersion))
      continue;
    const credential = hydrateNotionInstallation(row);
    await database
      .update(schema.notionInstallations)
      .set(notionCredentialFields(credential.accessToken, "dual-write"))
      .where(
        and(
          eq(schema.notionInstallations.id, row.id),
          eq(schema.notionInstallations.updatedAt, row.updatedAt),
          isNull(schema.notionInstallations.revokedAt),
        ),
      );
  }

  for (const row of slack) {
    if (row.revokedAt) {
      await database
        .update(schema.slackInstallations)
        .set(clearedSlackCredentialFields)
        .where(
          and(
            eq(schema.slackInstallations.id, row.id),
            eq(schema.slackInstallations.revokedAt, row.revokedAt),
            row.installedAt === null
              ? isNull(schema.slackInstallations.installedAt)
              : eq(schema.slackInstallations.installedAt, row.installedAt),
          ),
        );
      continue;
    }
    if (
      complete(row.botAccessTokenCiphertext, row.botAccessTokenNonce, row.botAccessTokenKeyVersion)
    )
      continue;
    const credential = hydrateSlackInstallation(row);
    await database
      .update(schema.slackInstallations)
      .set(slackCredentialFields(credential.botAccessToken, "dual-write"))
      .where(
        and(
          eq(schema.slackInstallations.id, row.id),
          isNull(schema.slackInstallations.revokedAt),
          row.installedAt === null
            ? isNull(schema.slackInstallations.installedAt)
            : eq(schema.slackInstallations.installedAt, row.installedAt),
        ),
      );
  }

  for (const row of webhooks) {
    if (complete(row.secretCiphertext, row.secretNonce, row.secretKeyVersion)) continue;
    const credential = hydrateWebhookEndpoint(row);
    await database
      .update(schema.webhookEndpoints)
      .set(webhookCredentialFields(credential.secret, "dual-write"))
      .where(
        and(
          eq(schema.webhookEndpoints.id, row.id),
          eq(schema.webhookEndpoints.updatedAt, row.updatedAt),
        ),
      );
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
      await database
        .update(schema.accounts)
        .set({ accessToken, refreshToken, idToken: null, updatedAt: new Date() })
        .where(and(eq(schema.accounts.id, row.id), eq(schema.accounts.updatedAt, row.updatedAt)));
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
  // intentionally occupies the existing columns. Connector values can only be
  // cleared after every one has a complete encrypted envelope.
  const connectorPlaintext =
    report.byStore.linear + report.byStore.notion + report.byStore.slack + report.byStore.webhooks;
  const connectorUnprotected =
    report.unprotectedByStore.linear +
    report.unprotectedByStore.notion +
    report.unprotectedByStore.slack +
    report.unprotectedByStore.webhooks;
  if (connectorPlaintext > 0 && connectorUnprotected > 0) {
    throw new Error(`refusing to erase ${connectorUnprotected} unprotected credential value(s)`);
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
