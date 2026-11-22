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
