import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, test } from "node:test";
import { inspect } from "node:util";
import {
  LEGACY_INTEGRATION_SECRET_KEY_VERSION,
  currentIntegrationSecretKeyVersion,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  integrationSecretEncryptionConfigured,
  parseIntegrationSecretKeyring,
} from "./integration-secrets.js";

const originalKey = process.env.AGENT_SECRETS_KEY;

afterEach(() => {
  if (originalKey === undefined) Reflect.deleteProperty(process.env, "AGENT_SECRETS_KEY");
  else process.env.AGENT_SECRETS_KEY = originalKey;
});

function key(): string {
  return randomBytes(32).toString("base64");
}

test("a single base64 key is the legacy format and means version 1", () => {
  const k1 = key();
  const keyring = parseIntegrationSecretKeyring(k1);

  assert.equal(LEGACY_INTEGRATION_SECRET_KEY_VERSION, 1);
  assert.equal(keyring.currentVersion, 1);
  assert.deepEqual(keyring.versions, [1]);
  assert.equal(keyring.key(1).length, 32);
});

test("a keyring lists the encrypting version first and decrypt-only versions after it", () => {
  const keyring = parseIntegrationSecretKeyring(`2:${key()},1:${key()}`);

  assert.equal(keyring.currentVersion, 2);
  assert.deepEqual(keyring.versions, [2, 1]);
  assert.notDeepEqual(keyring.key(2), keyring.key(1));
});

test("a keyring may stage a new decrypt-only version behind the current one", () => {
  const keyring = parseIntegrationSecretKeyring(`1:${key()},2:${key()}`);

  assert.equal(keyring.currentVersion, 1);
  assert.deepEqual(keyring.versions, [1, 2]);
});

test("keyring parsing tolerates surrounding whitespace and a trailing newline", () => {
  const keyring = parseIntegrationSecretKeyring(` 3:${key()} , 1:${key()}\n`);

  assert.equal(keyring.currentVersion, 3);
  assert.deepEqual(keyring.versions, [3, 1]);
  assert.equal(parseIntegrationSecretKeyring(`${key()}\n`).currentVersion, 1);
});

test("invalid keyrings are rejected without echoing key material", () => {
  const k1 = key();
  const k2 = key();
  const short = randomBytes(31).toString("base64");
  const cases: Array<[string | undefined, RegExp]> = [
    [undefined, /AGENT_SECRETS_KEY is required/],
    ["", /AGENT_SECRETS_KEY is required/],
    ["   ", /AGENT_SECRETS_KEY is required/],
    [short, /must decode to 32 bytes \(got 31\)/],
    ["not-a-key", /must decode to 32 bytes/],
    [`2:${k2},1:${k1},2:${k1}`, /version 2 appears more than once/],
    [`0:${k1}`, /entry 1 has an invalid version/],
    [`-1:${k1}`, /entry 1 has an invalid version/],
    [`1.5:${k1}`, /entry 1 has an invalid version/],
    [`abc:${k1}`, /entry 1 has an invalid version/],
    [`99999999999:${k1}`, /entry 1 has an invalid version/],
    [`2:${k2},${k1}`, /entry 2 must be <version>:<base64 key>/],
    [`2:${k2},`, /entry 2 is empty/],
    ["2:", /entry 1 \(version 2\) must decode to 32 bytes \(got 0\)/],
    [`2:${k2},1:${short}`, /entry 2 \(version 1\) must decode to 32 bytes \(got 31\)/],
  ];

  for (const [raw, expected] of cases) {
    assert.throws(
      () => parseIntegrationSecretKeyring(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected, `input case ${expected}`);
        for (const secret of [k1, k2, short, "not-a-key"]) {
          assert.ok(!error.message.includes(secret), "error message leaks key material");
        }
        return true;
      },
    );
    assert.equal(integrationSecretEncryptionConfigured(raw), false);
  }
});

test("a parsed keyring never prints its key bytes", () => {
  const k1 = key();
  const keyring = parseIntegrationSecretKeyring(`1:${k1}`);
  const rendered = `${inspect(keyring, { depth: 10, showHidden: true })} ${JSON.stringify(keyring)}`;

  assert.ok(!rendered.includes(k1));
  assert.ok(!rendered.includes(Buffer.from(k1, "base64").toString("hex")));
});

test("encryption is configured for both the legacy key and a keyring", () => {
  assert.equal(integrationSecretEncryptionConfigured(key()), true);
  assert.equal(integrationSecretEncryptionConfigured(`2:${key()},1:${key()}`), true);
});

test("encryption writes with the current version and decryption follows each row's version", () => {
  const k1 = key();
  const k2 = key();
  process.env.AGENT_SECRETS_KEY = k1;
  const legacyRow = encryptIntegrationSecret("written-before-rotation");
  assert.equal(legacyRow.keyVersion, 1);

  process.env.AGENT_SECRETS_KEY = `2:${k2},1:${k1}`;
  assert.equal(currentIntegrationSecretKeyVersion(), 2);
  const rotatedRow = encryptIntegrationSecret("written-after-rotation");

  assert.equal(rotatedRow.keyVersion, 2);
  assert.equal(decryptIntegrationSecret(legacyRow), "written-before-rotation");
  assert.equal(decryptIntegrationSecret(rotatedRow), "written-after-rotation");
});

test("a legacy single-key deployment still decrypts version 1 rows written by a keyring", () => {
  const k1 = key();
  process.env.AGENT_SECRETS_KEY = `1:${k1}`;
  const row = encryptIntegrationSecret("value");

  process.env.AGENT_SECRETS_KEY = k1;
  assert.equal(decryptIntegrationSecret(row), "value");
});

test("decrypting a version that is no longer configured fails clearly", () => {
  const k1 = key();
  const k2 = key();
  process.env.AGENT_SECRETS_KEY = k1;
  const legacyRow = encryptIntegrationSecret("value");

  process.env.AGENT_SECRETS_KEY = `2:${k2}`;
  assert.throws(
    () => decryptIntegrationSecret(legacyRow),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /key version 1 is not configured/);
      assert.match(error.message, /configured versions: 2/);
      assert.ok(!error.message.includes(k1) && !error.message.includes(k2));
      return true;
    },
  );
});

test("a key under the wrong version number fails authentication instead of returning garbage", () => {
  const k1 = key();
  process.env.AGENT_SECRETS_KEY = k1;
  const row = encryptIntegrationSecret("value");

  process.env.AGENT_SECRETS_KEY = `2:${k1},1:${key()}`;
  assert.throws(() => decryptIntegrationSecret(row));
});
