import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_DIGEST_POLICY, digestPolicyFromEnv } from "./policy.js";

const ENV_NAMES = [
  "DIGEST_INTERVAL_MS",
  "DIGEST_RETRY_COOLDOWN_MS",
  "DIGEST_CANDIDATE_LOOKBACK_MS",
  "DIGEST_CANDIDATE_LIMIT",
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]] as const),
);

afterEach(() => {
  for (const name of ENV_NAMES) {
    const original = ORIGINAL_ENV[name];
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
});

test("digestPolicyFromEnv returns defaults when env values are unset or empty", () => {
  for (const name of ENV_NAMES) process.env[name] = "";

  assert.deepEqual(digestPolicyFromEnv(), DEFAULT_DIGEST_POLICY);
});

test("digestPolicyFromEnv applies finite numeric env overrides", () => {
  process.env.DIGEST_INTERVAL_MS = "1000";
  process.env.DIGEST_RETRY_COOLDOWN_MS = "2000";
  process.env.DIGEST_CANDIDATE_LOOKBACK_MS = "3000";
  process.env.DIGEST_CANDIDATE_LIMIT = "4";

  assert.deepEqual(digestPolicyFromEnv(), {
    intervalMs: 1000,
    retryCooldownMs: 2000,
    candidateLookbackMs: 3000,
    candidateLimit: 4,
  });
});

test("digestPolicyFromEnv falls back per field for non-finite env values", () => {
  process.env.DIGEST_INTERVAL_MS = "not-a-number";
  process.env.DIGEST_RETRY_COOLDOWN_MS = "Infinity";
  process.env.DIGEST_CANDIDATE_LOOKBACK_MS = "5000";
  process.env.DIGEST_CANDIDATE_LIMIT = "NaN";

  assert.deepEqual(digestPolicyFromEnv(), {
    ...DEFAULT_DIGEST_POLICY,
    candidateLookbackMs: 5000,
  });
});
