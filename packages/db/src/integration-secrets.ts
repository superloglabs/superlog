import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;
const CURRENT_KEY_VERSION = 1;

export type IntegrationSecretCipher = {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
};

function getKey(version: number): Buffer {
  if (version !== CURRENT_KEY_VERSION) {
    throw new Error(`unknown integration secret key version: ${version}`);
  }
  const raw = process.env.AGENT_SECRETS_KEY;
  if (!raw) {
    throw new Error("AGENT_SECRETS_KEY is required to encrypt/decrypt integration secrets");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `AGENT_SECRETS_KEY must decode to 32 bytes (got ${key.length}); generate with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

export function encryptIntegrationSecret(plaintext: string): IntegrationSecretCipher {
  const key = getKey(CURRENT_KEY_VERSION);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]),
    nonce,
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decryptIntegrationSecret(cipher: IntegrationSecretCipher): string {
  const key = getKey(cipher.keyVersion);
  const enc = cipher.ciphertext.subarray(0, cipher.ciphertext.length - TAG_LEN);
  const tag = cipher.ciphertext.subarray(cipher.ciphertext.length - TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, cipher.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
