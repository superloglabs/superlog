import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedSignupEmailDomains, isSignupEmailBlocked } from "./signup-email-domains.js";

test("no domains are blocked unless the deployment configures some", () => {
  assert.deepEqual(blockedSignupEmailDomains({}), []);
  assert.deepEqual(blockedSignupEmailDomains({ SIGNUP_BLOCKED_EMAIL_DOMAINS: " , " }), []);
  assert.equal(isSignupEmailBlocked("someone@example.com", []), false);
});

test("parses a comma-separated, case-insensitive domain list", () => {
  assert.deepEqual(
    blockedSignupEmailDomains({ SIGNUP_BLOCKED_EMAIL_DOMAINS: " Spam.example ,@junk.test,," }),
    ["spam.example", "junk.test"],
  );
});

test("blocks addresses on a listed domain regardless of case", () => {
  const blocked = ["spam.example"];
  assert.equal(isSignupEmailBlocked("bot@spam.example", blocked), true);
  assert.equal(isSignupEmailBlocked("Bot@SPAM.Example", blocked), true);
  assert.equal(isSignupEmailBlocked("  bot@spam.example  ", blocked), true);
});

test("blocks subdomains of a listed domain", () => {
  assert.equal(isSignupEmailBlocked("bot@mail.spam.example", ["spam.example"]), true);
});

test("does not block lookalike or unrelated domains", () => {
  const blocked = ["spam.example"];
  assert.equal(isSignupEmailBlocked("person@notspam.example", blocked), false);
  assert.equal(isSignupEmailBlocked("person@spam.example.org", blocked), false);
  assert.equal(isSignupEmailBlocked("spam.example@legit.test", blocked), false);
});

test("uses the domain after the last @", () => {
  assert.equal(isSignupEmailBlocked('"a@legit.test"@spam.example', ["spam.example"]), true);
  assert.equal(isSignupEmailBlocked("no-at-sign", ["spam.example"]), false);
});
