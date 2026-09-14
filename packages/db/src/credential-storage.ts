import { decryptIntegrationSecret, encryptIntegrationSecret } from "./integration-secrets.js";
import type {
  LinearInstallation,
  LinearInstallationRow,
  NotionInstallation,
  NotionInstallationRow,
  SlackInstallation,
  SlackInstallationRow,
  WebhookEndpoint,
  WebhookEndpointRow,
} from "./schema.js";

export type CredentialStorageMode = "dual-write" | "encrypted-only";

export type StoredCredential = {
  plaintext: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  keyVersion: number | null;
};

type CompleteStoredCredential = StoredCredential & {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
};

function completeEncryptedCredential(stored: StoredCredential): stored is CompleteStoredCredential {
  return stored.ciphertext !== null && stored.nonce !== null && stored.keyVersion !== null;
}

export function storedCredentialNeedsProtection(
  stored: StoredCredential,
  required = false,
): boolean {
  const hasAnyValue =
    required ||
    stored.plaintext !== null ||
    stored.ciphertext !== null ||
    stored.nonce !== null ||
    stored.keyVersion !== null;
  if (!hasAnyValue) return false;
  if (!completeEncryptedCredential(stored)) return true;
  if (stored.plaintext === null) return false;
  return (
    stored.plaintext !==
    decryptIntegrationSecret({
      ciphertext: stored.ciphertext,
      nonce: stored.nonce,
      keyVersion: stored.keyVersion,
    })
  );
}

export function readStoredCredential(stored: StoredCredential): string {
  const encryptedFieldCount = [stored.ciphertext, stored.nonce, stored.keyVersion].filter(
    (value) => value !== null,
  ).length;
  if (encryptedFieldCount > 0 && encryptedFieldCount < 3) {
    throw new Error("stored credential encryption fields are incomplete");
  }
  if (stored.ciphertext && stored.nonce && stored.keyVersion !== null) {
    const decrypted = decryptIntegrationSecret({
      ciphertext: stored.ciphertext,
      nonce: stored.nonce,
      keyVersion: stored.keyVersion,
    });
    if (stored.plaintext !== null && stored.plaintext !== decrypted) {
      throw new Error("stored credential plaintext and encrypted copies do not match");
    }
    return decrypted;
  }
  if (stored.plaintext !== null) return stored.plaintext;
  throw new Error("stored credential is unavailable");
}

export function prepareStoredCredential(
  plaintext: string,
  mode: CredentialStorageMode,
): StoredCredential {
  const encrypted = encryptIntegrationSecret(plaintext);
  return {
    plaintext: mode === "dual-write" ? plaintext : null,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    keyVersion: encrypted.keyVersion,
  };
}

export function credentialStorageMode(
  value: string | undefined = process.env.CREDENTIAL_STORAGE_MODE,
): CredentialStorageMode {
  if (value === undefined || value === "") return "dual-write";
  if (value === "dual-write" || value === "encrypted-only") return value;
  throw new Error(
    `CREDENTIAL_STORAGE_MODE must be "dual-write" or "encrypted-only" (got ${value})`,
  );
}

function readOptionalStoredCredential(stored: StoredCredential): string | null {
  if (
    stored.plaintext === null &&
    stored.ciphertext === null &&
    stored.nonce === null &&
    stored.keyVersion === null
  ) {
    return null;
  }
  return readStoredCredential(stored);
}

function prepareOptionalStoredCredential(
  plaintext: string | null,
  mode: CredentialStorageMode,
): StoredCredential {
  return plaintext === null
    ? { plaintext: null, ciphertext: null, nonce: null, keyVersion: null }
    : prepareStoredCredential(plaintext, mode);
}

export function slackCredentialFields(
  token: string,
  mode = credentialStorageMode(),
): Pick<
  SlackInstallationRow,
  "botAccessToken" | "botAccessTokenCiphertext" | "botAccessTokenNonce" | "botAccessTokenKeyVersion"
> {
  const stored = prepareStoredCredential(token, mode);
  return {
    botAccessToken: stored.plaintext,
    botAccessTokenCiphertext: stored.ciphertext,
    botAccessTokenNonce: stored.nonce,
    botAccessTokenKeyVersion: stored.keyVersion,
  };
}

export const clearedSlackCredentialFields = {
  botAccessToken: null,
  botAccessTokenCiphertext: null,
  botAccessTokenNonce: null,
  botAccessTokenKeyVersion: null,
} satisfies ReturnType<typeof slackCredentialFields>;

export function hydrateSlackInstallation(row: SlackInstallationRow): SlackInstallation {
  const {
    botAccessTokenCiphertext,
    botAccessTokenNonce,
    botAccessTokenKeyVersion,
    ...installation
  } = row;
  return {
    ...installation,
    botAccessToken: readStoredCredential({
      plaintext: row.botAccessToken,
      ciphertext: botAccessTokenCiphertext,
      nonce: botAccessTokenNonce,
      keyVersion: botAccessTokenKeyVersion,
    }),
  };
}

export function linearCredentialFields(
  input: { accessToken: string; refreshToken: string | null; webhookSecret: string | null },
  mode = credentialStorageMode(),
): Pick<
  LinearInstallationRow,
  | "accessToken"
  | "accessTokenCiphertext"
  | "accessTokenNonce"
  | "accessTokenKeyVersion"
  | "refreshToken"
  | "refreshTokenCiphertext"
  | "refreshTokenNonce"
  | "refreshTokenKeyVersion"
  | "webhookSecret"
  | "webhookSecretCiphertext"
  | "webhookSecretNonce"
  | "webhookSecretKeyVersion"
> {
  const access = prepareStoredCredential(input.accessToken, mode);
  const refresh = prepareOptionalStoredCredential(input.refreshToken, mode);
  const webhook = prepareOptionalStoredCredential(input.webhookSecret, mode);
  return {
    accessToken: access.plaintext,
    accessTokenCiphertext: access.ciphertext,
    accessTokenNonce: access.nonce,
    accessTokenKeyVersion: access.keyVersion,
    refreshToken: refresh.plaintext,
    refreshTokenCiphertext: refresh.ciphertext,
    refreshTokenNonce: refresh.nonce,
    refreshTokenKeyVersion: refresh.keyVersion,
    webhookSecret: webhook.plaintext,
    webhookSecretCiphertext: webhook.ciphertext,
    webhookSecretNonce: webhook.nonce,
    webhookSecretKeyVersion: webhook.keyVersion,
  };
}

export const clearedLinearCredentialFields = {
  accessToken: null,
  accessTokenCiphertext: null,
  accessTokenNonce: null,
  accessTokenKeyVersion: null,
  refreshToken: null,
  refreshTokenCiphertext: null,
  refreshTokenNonce: null,
  refreshTokenKeyVersion: null,
  webhookSecret: null,
  webhookSecretCiphertext: null,
  webhookSecretNonce: null,
  webhookSecretKeyVersion: null,
} satisfies Partial<ReturnType<typeof linearCredentialFields>>;

export function hydrateLinearInstallation(row: LinearInstallationRow): LinearInstallation {
  const {
    accessTokenCiphertext,
    accessTokenNonce,
    accessTokenKeyVersion,
    refreshTokenCiphertext,
    refreshTokenNonce,
    refreshTokenKeyVersion,
    webhookSecretCiphertext,
    webhookSecretNonce,
    webhookSecretKeyVersion,
    ...installation
  } = row;
  return {
    ...installation,
    accessToken: readStoredCredential({
      plaintext: row.accessToken,
      ciphertext: accessTokenCiphertext,
      nonce: accessTokenNonce,
      keyVersion: accessTokenKeyVersion,
    }),
    refreshToken: readOptionalStoredCredential({
      plaintext: row.refreshToken,
      ciphertext: refreshTokenCiphertext,
      nonce: refreshTokenNonce,
      keyVersion: refreshTokenKeyVersion,
    }),
    webhookSecret: readOptionalStoredCredential({
      plaintext: row.webhookSecret,
      ciphertext: webhookSecretCiphertext,
      nonce: webhookSecretNonce,
      keyVersion: webhookSecretKeyVersion,
    }),
  };
}

export function notionCredentialFields(
  token: string,
  mode = credentialStorageMode(),
): Pick<
  NotionInstallationRow,
  "accessToken" | "accessTokenCiphertext" | "accessTokenNonce" | "accessTokenKeyVersion"
> {
  const stored = prepareStoredCredential(token, mode);
  return {
    accessToken: stored.plaintext,
    accessTokenCiphertext: stored.ciphertext,
    accessTokenNonce: stored.nonce,
    accessTokenKeyVersion: stored.keyVersion,
  };
}

export const clearedNotionCredentialFields = {
  accessToken: null,
  accessTokenCiphertext: null,
  accessTokenNonce: null,
  accessTokenKeyVersion: null,
} satisfies Partial<ReturnType<typeof notionCredentialFields>>;

export function hydrateNotionInstallation(row: NotionInstallationRow): NotionInstallation {
  const { accessTokenCiphertext, accessTokenNonce, accessTokenKeyVersion, ...installation } = row;
  return {
    ...installation,
    accessToken: readStoredCredential({
      plaintext: row.accessToken,
      ciphertext: accessTokenCiphertext,
      nonce: accessTokenNonce,
      keyVersion: accessTokenKeyVersion,
    }),
  };
}

export function webhookCredentialFields(
  secret: string,
  mode = credentialStorageMode(),
): Pick<WebhookEndpointRow, "secret" | "secretCiphertext" | "secretNonce" | "secretKeyVersion"> {
  const stored = prepareStoredCredential(secret, mode);
  return {
    secret: stored.plaintext,
    secretCiphertext: stored.ciphertext,
    secretNonce: stored.nonce,
    secretKeyVersion: stored.keyVersion,
  };
}

export function hydrateWebhookEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  const { secretCiphertext, secretNonce, secretKeyVersion, ...endpoint } = row;
  return {
    ...endpoint,
    secret: readStoredCredential({
      plaintext: row.secret,
      ciphertext: secretCiphertext,
      nonce: secretNonce,
      keyVersion: secretKeyVersion,
    }),
  };
}
