import { strict as assert } from "node:assert";
import { test } from "node:test";
import { newSignupsOpen } from "./signup-policy.js";

test("production keeps sign-ups closed by default", () => {
  assert.equal(newSignupsOpen({ NODE_ENV: "production" }), false);
});

test("production can reopen sign-ups explicitly", () => {
  assert.equal(newSignupsOpen({ NODE_ENV: "production", SIGNUPS_ENABLED: "true" }), true);
});

test("other environments stay open unless turned off", () => {
  assert.equal(newSignupsOpen({ NODE_ENV: "development" }), true);
  assert.equal(newSignupsOpen({}), true);
  assert.equal(newSignupsOpen({ NODE_ENV: "test", SIGNUPS_ENABLED: "false" }), false);
});

test("SUPERLOG_ENV identifies production even without NODE_ENV", () => {
  assert.equal(newSignupsOpen({ SUPERLOG_ENV: "production" }), false);
  assert.equal(newSignupsOpen({ SUPERLOG_ENV: "production", NODE_ENV: "development" }), false);
  assert.equal(newSignupsOpen({ SUPERLOG_ENV: "staging", NODE_ENV: "production" }), true);
});

test("an empty SUPERLOG_ENV falls through to NODE_ENV", () => {
  assert.equal(newSignupsOpen({ SUPERLOG_ENV: "", NODE_ENV: "production" }), false);
  assert.equal(newSignupsOpen({ SUPERLOG_ENV: "  ", NODE_ENV: "production" }), false);
});
