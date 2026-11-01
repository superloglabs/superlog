import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  normalizeSignupIntentKeyHash,
  normalizeSignupIntentKeyPrefix,
  normalizeSignupIntentReturnTo,
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

test("signup intent returnTo only keeps loopback agent callbacks", () => {
  for (const url of [
    "http://localhost:7777/callback",
    "http://127.0.0.1:7777/callback?state=1",
    "https://localhost/done",
    "http://[::1]:7777/callback",
  ]) {
    assert.equal(normalizeSignupIntentReturnTo(url), url);
  }
});

test("signup intent returnTo drops anything that could leave the machine", () => {
  for (const value of [
    "https://attacker.example.invalid/capture?x=1",
    "https://localhost.attacker.example.invalid/",
    "http://localhost@attacker.example.invalid/",
    "//attacker.example.invalid",
    "/relative",
    "javascript:alert(1)",
    "vscode://open",
    `http://localhost/${"a".repeat(1024)}`,
    42,
    null,
  ]) {
    assert.equal(normalizeSignupIntentReturnTo(value), null);
  }
});
