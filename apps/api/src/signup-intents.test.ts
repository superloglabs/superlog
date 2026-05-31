import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  normalizeSignupIntentKeyHash,
  normalizeSignupIntentKeyPrefix,
} from "./signup-intents.js";

test("signup intent key prefix accepts generated public ingest key prefixes", () => {
  assert.equal(normalizeSignupIntentKeyPrefix("sl_public_abc123"), "sl_public_abc123");
});

test("signup intent key prefix keeps legacy ingest key compatibility", () => {
  assert.equal(normalizeSignupIntentKeyPrefix("superlog_live_abc123"), "superlog_live_abc123");
});

test("signup intent key prefix rejects full tokens and malformed prefixes", () => {
  assert.equal(normalizeSignupIntentKeyPrefix("sl_public_abc123extra"), null);
  assert.equal(normalizeSignupIntentKeyPrefix("sl_private_abc123"), null);
  assert.equal(normalizeSignupIntentKeyPrefix("sl_public_abc12!"), null);
  assert.equal(normalizeSignupIntentKeyPrefix(null), null);
});

test("signup intent key hash requires sha256 hex and normalizes case", () => {
  const upper = "A".repeat(64);
  assert.equal(normalizeSignupIntentKeyHash(upper), upper.toLowerCase());
  assert.equal(normalizeSignupIntentKeyHash("a".repeat(63)), null);
  assert.equal(normalizeSignupIntentKeyHash("g".repeat(64)), null);
});
