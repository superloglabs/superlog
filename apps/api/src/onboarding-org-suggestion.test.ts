import assert from "node:assert/strict";
import test from "node:test";
import { suggestOrgNameFromGoogleIdToken } from "./onboarding-org-suggestion.js";

function unsignedIdToken(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("suggests the first Google Workspace domain label as the organization name", () => {
  assert.equal(suggestOrgNameFromGoogleIdToken(unsignedIdToken({ hd: "acme.com" })), "Acme");
});

test("does not suggest an organization for a consumer Google account", () => {
  assert.equal(suggestOrgNameFromGoogleIdToken(unsignedIdToken({ email: "jane@gmail.com" })), null);
});
