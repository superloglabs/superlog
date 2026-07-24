import assert from "node:assert/strict";
import test from "node:test";
import { suggestedOrgName } from "./onboarding/orgNameSuggestion.ts";

test("prefers a Google Workspace organization suggestion over the user's display name", () => {
  assert.equal(
    suggestedOrgName({
      workspaceOrgName: "Acme",
      userName: "Jane Doe",
      userEmail: "jane@acme.com",
    }),
    "Acme",
  );
});

test("falls back to the user's display name without a Workspace suggestion", () => {
  assert.equal(
    suggestedOrgName({
      workspaceOrgName: null,
      userName: "Jane Doe",
      userEmail: "jane@gmail.com",
    }),
    "Jane Doe's org",
  );
});
