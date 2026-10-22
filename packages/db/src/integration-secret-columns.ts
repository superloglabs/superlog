import { type PgColumn, type PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/**
 * How a column stores the AES-GCM nonce. Most tables use `bytea`; the Sentry
 * installation table stores it as base64 text.
 */
export type NonceEncoding = "bytea" | "base64-text";

/**
 * One envelope encrypted with `AGENT_SECRETS_KEY`: a ciphertext column, its
 * nonce, and the key version it was written with, plus the row's primary key.
 */
export type EncryptedSecretColumn = {
  table: PgTable;
  id: PgColumn;
  ciphertext: PgColumn;
  nonce: PgColumn;
  keyVersion: PgColumn;
  nonceEncoding: NonceEncoding;
};

function envelope<T extends PgTable & { id: PgColumn }>(
  table: T,
  columns: (table: T) => { ciphertext: PgColumn; nonce: PgColumn; keyVersion: PgColumn },
  nonceEncoding: NonceEncoding = "bytea",
): EncryptedSecretColumn {
  return { table, id: table.id, ...columns(table), nonceEncoding };
}

/** `<table>.<key version column>`, e.g. `linear_installations.access_token_key_version`. */
export function encryptedSecretColumnLabel(column: EncryptedSecretColumn): string {
  return `${getTableConfig(column.table).name}.${column.keyVersion.name}`;
}

/**
 * Every column encrypted with `AGENT_SECRETS_KEY`. Key rotation re-encrypts
 * exactly these columns, so a new encrypted column must be added here; the
 * rewrap test fails for any `*_key_version` column in the schema that is
 * missing from this list.
 */
export const ENCRYPTED_INTEGRATION_SECRET_COLUMNS: readonly EncryptedSecretColumn[] = [
  envelope(schema.projectMcpServers, (t) => ({
    ciphertext: t.authCiphertext,
    nonce: t.authNonce,
    keyVersion: t.authKeyVersion,
  })),
  envelope(schema.projectMcpOauthAttempts, (t) => ({
    ciphertext: t.payloadCiphertext,
    nonce: t.payloadNonce,
    keyVersion: t.payloadKeyVersion,
  })),
  envelope(schema.webhookEndpoints, (t) => ({
    ciphertext: t.secretCiphertext,
    nonce: t.secretNonce,
    keyVersion: t.secretKeyVersion,
  })),
  envelope(schema.slackInstallations, (t) => ({
    ciphertext: t.botAccessTokenCiphertext,
    nonce: t.botAccessTokenNonce,
    keyVersion: t.botAccessTokenKeyVersion,
  })),
  envelope(schema.linearInstallations, (t) => ({
    ciphertext: t.accessTokenCiphertext,
    nonce: t.accessTokenNonce,
    keyVersion: t.accessTokenKeyVersion,
  })),
  envelope(schema.linearInstallations, (t) => ({
    ciphertext: t.refreshTokenCiphertext,
    nonce: t.refreshTokenNonce,
    keyVersion: t.refreshTokenKeyVersion,
  })),
  envelope(schema.linearInstallations, (t) => ({
    ciphertext: t.webhookSecretCiphertext,
    nonce: t.webhookSecretNonce,
    keyVersion: t.webhookSecretKeyVersion,
  })),
  envelope(schema.notionInstallations, (t) => ({
    ciphertext: t.accessTokenCiphertext,
    nonce: t.accessTokenNonce,
    keyVersion: t.accessTokenKeyVersion,
  })),
  envelope(
    schema.sentryInstallations,
    (t) => ({
      ciphertext: t.accessTokenCiphertext,
      nonce: t.accessTokenNonce,
      keyVersion: t.accessTokenKeyVersion,
    }),
    "base64-text",
  ),
  envelope(
    schema.sentryInstallations,
    (t) => ({
      ciphertext: t.refreshTokenCiphertext,
      nonce: t.refreshTokenNonce,
      keyVersion: t.refreshTokenKeyVersion,
    }),
    "base64-text",
  ),
  envelope(
    schema.sentryInstallations,
    (t) => ({
      ciphertext: t.relayTokenCiphertext,
      nonce: t.relayTokenNonce,
      keyVersion: t.relayTokenKeyVersion,
    }),
    "base64-text",
  ),
  envelope(schema.sentryAuthorizationSessions, (t) => ({
    ciphertext: t.accessTokenCiphertext,
    nonce: t.accessTokenNonce,
    keyVersion: t.accessTokenKeyVersion,
  })),
  envelope(schema.sentryAuthorizationSessions, (t) => ({
    ciphertext: t.refreshTokenCiphertext,
    nonce: t.refreshTokenNonce,
    keyVersion: t.refreshTokenKeyVersion,
  })),
  envelope(schema.orgIntegrationSecrets, (t) => ({
    ciphertext: t.ciphertext,
    nonce: t.nonce,
    keyVersion: t.keyVersion,
  })),
  envelope(schema.cloudConnections, (t) => ({
    ciphertext: t.externalIdCiphertext,
    nonce: t.externalIdNonce,
    keyVersion: t.externalIdKeyVersion,
  })),
  envelope(schema.cloudStreamKeys, (t) => ({
    ciphertext: t.keyCiphertext,
    nonce: t.keyNonce,
    keyVersion: t.keyKeyVersion,
  })),
  envelope(schema.gcpAuthorizationSessions, (t) => ({
    ciphertext: t.accessTokenCiphertext,
    nonce: t.accessTokenNonce,
    keyVersion: t.accessTokenKeyVersion,
  })),
  envelope(schema.gcpConnections, (t) => ({
    ciphertext: t.ingestKeyCiphertext,
    nonce: t.ingestKeyNonce,
    keyVersion: t.ingestKeyKeyVersion,
  })),
  envelope(schema.cloudflareInstallations, (t) => ({
    ciphertext: t.accessTokenCiphertext,
    nonce: t.accessTokenNonce,
    keyVersion: t.accessTokenKeyVersion,
  })),
  envelope(schema.cloudflareInstallations, (t) => ({
    ciphertext: t.refreshTokenCiphertext,
    nonce: t.refreshTokenNonce,
    keyVersion: t.refreshTokenKeyVersion,
  })),
  envelope(schema.cloudflareInstallations, (t) => ({
    ciphertext: t.ingestKeyCiphertext,
    nonce: t.ingestKeyNonce,
    keyVersion: t.ingestKeyKeyVersion,
  })),
  envelope(schema.vercelInstallations, (t) => ({
    ciphertext: t.accessTokenCiphertext,
    nonce: t.accessTokenNonce,
    keyVersion: t.accessTokenKeyVersion,
  })),
  envelope(schema.vercelInstallations, (t) => ({
    ciphertext: t.ingestKeyCiphertext,
    nonce: t.ingestKeyNonce,
    keyVersion: t.ingestKeyKeyVersion,
  })),
  envelope(schema.railwayInstallations, (t) => ({
    ciphertext: t.accessTokenCiphertext,
    nonce: t.accessTokenNonce,
    keyVersion: t.accessTokenKeyVersion,
  })),
  envelope(schema.railwayInstallations, (t) => ({
    ciphertext: t.refreshTokenCiphertext,
    nonce: t.refreshTokenNonce,
    keyVersion: t.refreshTokenKeyVersion,
  })),
  envelope(schema.railwayInstallations, (t) => ({
    ciphertext: t.ingestKeyCiphertext,
    nonce: t.ingestKeyNonce,
    keyVersion: t.ingestKeyKeyVersion,
  })),
  envelope(schema.renderInstallations, (t) => ({
    ciphertext: t.renderApiKeyCiphertext,
    nonce: t.renderApiKeyNonce,
    keyVersion: t.renderApiKeyKeyVersion,
  })),
  envelope(schema.renderInstallations, (t) => ({
    ciphertext: t.ingestKeyCiphertext,
    nonce: t.ingestKeyNonce,
    keyVersion: t.ingestKeyKeyVersion,
  })),
];
