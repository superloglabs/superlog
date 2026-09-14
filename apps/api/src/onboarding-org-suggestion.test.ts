import assert from "node:assert/strict";
import test from "node:test";
import { suggestOrgNameFromEmail } from "./onboarding-org-suggestion.js";

test("suggests the first business email domain label as the organization name", () => {
  assert.equal(suggestOrgNameFromEmail("jane@acme.com"), "Acme");
});

test("does not suggest an organization for a consumer email domain", () => {
  assert.equal(suggestOrgNameFromEmail("jane@gmail.com"), null);
});

test("rejects malformed email addresses", () => {
  assert.equal(suggestOrgNameFromEmail("not-an-email"), null);
});
