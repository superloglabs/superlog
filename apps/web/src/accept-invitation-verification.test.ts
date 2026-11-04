import assert from "node:assert/strict";
import test from "node:test";
import { isEmailVerificationRequiredError } from "./accept-invitation-verification.js";

test("matches the message from the gated invitation read", () => {
  assert.equal(
    isEmailVerificationRequiredError("Email verification required for invitation"),
    true,
  );
});

test("matches the message from the gated accept call", () => {
  assert.equal(
    isEmailVerificationRequiredError(
      "Email verification required before accepting or rejecting invitation",
    ),
    true,
  );
});

test("ignores unrelated invitation failures", () => {
  assert.equal(isEmailVerificationRequiredError("Invitation not found!"), false);
  assert.equal(
    isEmailVerificationRequiredError("You are not the recipient of the invitation"),
    false,
  );
  assert.equal(isEmailVerificationRequiredError(undefined), false);
});
