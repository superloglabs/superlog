import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
// key_version columns are Postgres `integer`.
const MAX_KEY_VERSION = 2_147_483_647;

/**
 * The version implied by the single-key `AGENT_SECRETS_KEY` format, and the
 * version of any envelope written before key versions were recorded.
 */
export const LEGACY_INTEGRATION_SECRET_KEY_VERSION = 1;

export type IntegrationSecretCipher = {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
};

/**
 * Parsed `AGENT_SECRETS_KEY`. Two formats are accepted:
 *
 * - a single base64 key (32 bytes decoded), which is version 1;
 * - a keyring `"<version>:<base64>,<version>:<base64>,..."`. The first entry is
 *   the current version used for new encryptions; the rest are decrypt-only.
 *
 * Key bytes live in a private field so logging or serializing a keyring never
 * prints key material.
 */
export class IntegrationSecretKeyring {
  readonly currentVersion: number;
  readonly versions: readonly number[];
  readonly #keys: ReadonlyMap<number, Buffer>;

  constructor(entries: ReadonlyArray<readonly [number, Buffer]>) {
    const first = entries[0];
    if (!first) throw new Error("AGENT_SECRETS_KEY keyring has no entries");
    this.currentVersion = first[0];
    this.versions = entries.map(([version]) => version);
    this.#keys = new Map(entries);
  }

  has(version: number): boolean {
    return this.#keys.has(version);
  }

  key(version: number): Buffer {
    const key = this.#keys.get(version);
    if (!key) {
      throw new Error(
        `integration secret key version ${version} is not configured in AGENT_SECRETS_KEY (configured versions: ${this.versions.join(", ")})`,
      );
    }
    return key;
  }

  toJSON(): { currentVersion: number; versions: readonly number[] } {
    return { currentVersion: this.currentVersion, versions: this.versions };
  }
}

function decodeKey(encoded: string, label: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(
      `${label} must decode to ${KEY_LEN} bytes (got ${key.length}); generate with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

function parseVersion(token: string, position: number): number {
  const version = /^\d+$/.test(token) ? Number(token) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    // The token is not echoed: a malformed entry may be a mis-pasted key.
    throw new Error(
      `AGENT_SECRETS_KEY entry ${position} has an invalid version; expected an integer from 1 to ${MAX_KEY_VERSION}`,
    );
  }
  return version;
}

export function parseIntegrationSecretKeyring(raw: string | undefined): IntegrationSecretKeyring {
  const value = raw?.trim() ?? "";
  if (value === "") {
    throw new Error("AGENT_SECRETS_KEY is required to encrypt/decrypt integration secrets");
  }
  // Base64 never contains ":" or ",", so either one marks the keyring format.
  if (!value.includes(":") && !value.includes(",")) {
    return new IntegrationSecretKeyring([
      [LEGACY_INTEGRATION_SECRET_KEY_VERSION, decodeKey(value, "AGENT_SECRETS_KEY")],
    ]);
  }

  const entries: Array<[number, Buffer]> = [];
  const seen = new Set<number>();
  value.split(",").forEach((rawEntry, index) => {
    const position = index + 1;
    const entry = rawEntry.trim();
    if (entry === "") throw new Error(`AGENT_SECRETS_KEY entry ${position} is empty`);
    const separator = entry.indexOf(":");
    if (separator === -1) {
      throw new Error(`AGENT_SECRETS_KEY entry ${position} must be <version>:<base64 key>`);
    }
    const version = parseVersion(entry.slice(0, separator).trim(), position);
    if (seen.has(version)) {
      throw new Error(`AGENT_SECRETS_KEY version ${version} appears more than once`);
    }
    seen.add(version);
    const key = decodeKey(
      entry.slice(separator + 1).trim(),
      `AGENT_SECRETS_KEY entry ${position} (version ${version})`,
    );
    entries.push([version, key]);
  });
  return new IntegrationSecretKeyring(entries);
}

let cached: { raw: string; keyring: IntegrationSecretKeyring } | null = null;

/** The keyring from `process.env.AGENT_SECRETS_KEY`. Throws if it is missing or invalid. */
export function integrationSecretKeyring(): IntegrationSecretKeyring {
  const raw = process.env.AGENT_SECRETS_KEY;
  if (raw !== undefined && cached?.raw === raw) return cached.keyring;
  const keyring = parseIntegrationSecretKeyring(raw);
  if (raw !== undefined) cached = { raw, keyring };
  return keyring;
}

/**
 * True when `raw` is a valid single key or keyring. Takes the value explicitly
 * (no environment fallback), for callers that read configuration from an env
 * object other than `process.env`.
 */
export function isValidIntegrationSecretKeyring(raw: string | undefined): boolean {
  try {
    parseIntegrationSecretKeyring(raw);
    return true;
  } catch {
    return false;
  }
}

/** True when `AGENT_SECRETS_KEY` (or `raw`, when given) holds a valid single key or keyring. */
export function integrationSecretEncryptionConfigured(
  raw: string | undefined = process.env.AGENT_SECRETS_KEY,
): boolean {
  return isValidIntegrationSecretKeyring(raw);
}

/** The version new encryptions are written with. */
export function currentIntegrationSecretKeyVersion(): number {
  return integrationSecretKeyring().currentVersion;
}

export function encryptIntegrationSecret(
  plaintext: string,
  keyring: IntegrationSecretKeyring = integrationSecretKeyring(),
): IntegrationSecretCipher {
  const keyVersion = keyring.currentVersion;
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGORITHM, keyring.key(keyVersion), nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]),
    nonce,
    keyVersion,
  };
}

export function decryptIntegrationSecret(
  cipher: IntegrationSecretCipher,
  keyring: IntegrationSecretKeyring = integrationSecretKeyring(),
): string {
  const key = keyring.key(cipher.keyVersion);
  const enc = cipher.ciphertext.subarray(0, cipher.ciphertext.length - TAG_LEN);
  const tag = cipher.ciphertext.subarray(cipher.ciphertext.length - TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, cipher.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
