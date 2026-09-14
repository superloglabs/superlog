import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  credentialStorageMode,
  prepareStoredCredential,
  readStoredCredential,
} from "./credential-storage.js";
import {
  encryptIntegrationSecret,
  integrationSecretEncryptionConfigured,
} from "./integration-secrets.js";

const originalKey = process.env.AGENT_SECRETS_KEY;

before(() => {
  process.env.AGENT_SECRETS_KEY = randomBytes(32).toString("base64");
});

after(() => {
  if (originalKey === undefined) Reflect.deleteProperty(process.env, "AGENT_SECRETS_KEY");
  else process.env.AGENT_SECRETS_KEY = originalKey;
});

test("encrypted credentials take precedence while legacy plaintext remains during rollout", () => {
  const encrypted = encryptIntegrationSecret("encrypted-value");

  assert.equal(
    readStoredCredential({
      plaintext: "legacy-value",
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keyVersion: encrypted.keyVersion,
    }),
    "encrypted-value",
  );
});

test("legacy plaintext credentials remain readable before backfill", () => {
  assert.equal(
    readStoredCredential({
      plaintext: "legacy-value",
      ciphertext: null,
      nonce: null,
      keyVersion: null,
    }),
    "legacy-value",
  );
});

test("dual-write mode keeps legacy readers working while adding ciphertext", () => {
  const stored = prepareStoredCredential("credential", "dual-write");

  assert.equal(stored.plaintext, "credential");
  assert.ok(stored.ciphertext);
  assert.ok(stored.nonce);
  assert.equal(stored.keyVersion, 1);
  assert.equal(readStoredCredential(stored), "credential");
});

test("encrypted-only mode omits the legacy plaintext value", () => {
  const stored = prepareStoredCredential("credential", "encrypted-only");

  assert.equal(stored.plaintext, null);
  assert.equal(readStoredCredential(stored), "credential");
});

test("storage mode defaults safely for a rolling deployment and rejects typos", () => {
  assert.equal(credentialStorageMode(undefined), "dual-write");
  assert.equal(credentialStorageMode("encrypted-only"), "encrypted-only");
  assert.throws(() => credentialStorageMode("encrypted"), /must be/);
});

test("credential writes require a valid 32-byte encryption key", () => {
  assert.equal(integrationSecretEncryptionConfigured(""), false);
  assert.equal(integrationSecretEncryptionConfigured("not-a-key"), false);
  assert.equal(
    integrationSecretEncryptionConfigured(Buffer.alloc(31, 1).toString("base64")),
    false,
  );
  assert.equal(
    integrationSecretEncryptionConfigured(Buffer.alloc(32, 1).toString("base64")),
    true,
  );
});

test("partial ciphertext never silently falls back to plaintext", () => {
  assert.throws(
    () =>
      readStoredCredential({
        plaintext: "legacy-value",
        ciphertext: Buffer.from("corrupt"),
        nonce: null,
        keyVersion: 1,
      }),
    /incomplete/,
  );
});
