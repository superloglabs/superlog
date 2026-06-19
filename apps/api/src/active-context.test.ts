import { strict as assert } from "node:assert";
import { test } from "node:test";
import { favoriteProjectToSeed, pickActiveOrgId } from "./active-context.js";

test("pickActiveOrgId: favorite wins when the user is still a member", () => {
  const orgId = pickActiveOrgId({
    favoriteOrgId: "fav",
    lastUsedOrgId: "last",
    memberOrgIds: ["first", "last", "fav"],
  });
  assert.equal(orgId, "fav");
});

test("pickActiveOrgId: falls back to last-used when no favorite is set", () => {
  const orgId = pickActiveOrgId({
    favoriteOrgId: null,
    lastUsedOrgId: "last",
    memberOrgIds: ["first", "last"],
  });
  assert.equal(orgId, "last");
});

test("pickActiveOrgId: falls back to first membership when neither favorite nor last-used apply", () => {
  const orgId = pickActiveOrgId({
    favoriteOrgId: null,
    lastUsedOrgId: null,
    memberOrgIds: ["first", "second"],
  });
  assert.equal(orgId, "first");
});

test("pickActiveOrgId: skips a favorite the user is no longer a member of", () => {
  const orgId = pickActiveOrgId({
    favoriteOrgId: "left-this-org",
    lastUsedOrgId: "last",
    memberOrgIds: ["first", "last"],
  });
  assert.equal(orgId, "last");
});

test("pickActiveOrgId: skips a last-used org the user is no longer a member of", () => {
  const orgId = pickActiveOrgId({
    favoriteOrgId: null,
    lastUsedOrgId: "left-this-org",
    memberOrgIds: ["first", "second"],
  });
  assert.equal(orgId, "first");
});

test("pickActiveOrgId: returns null when the user has no memberships", () => {
  const orgId = pickActiveOrgId({
    favoriteOrgId: "fav",
    lastUsedOrgId: "last",
    memberOrgIds: [],
  });
  assert.equal(orgId, null);
});

test("favoriteProjectToSeed: returns the favorite project when its org is the active org", () => {
  const projectId = favoriteProjectToSeed({
    favoriteProjectId: "p1",
    favoriteOrgId: "orgA",
    activeOrgId: "orgA",
  });
  assert.equal(projectId, "p1");
});

test("favoriteProjectToSeed: returns null when the active org is not the favorite's org", () => {
  const projectId = favoriteProjectToSeed({
    favoriteProjectId: "p1",
    favoriteOrgId: "orgA",
    activeOrgId: "orgB",
  });
  assert.equal(projectId, null);
});

test("favoriteProjectToSeed: returns null when no favorite project is set", () => {
  const projectId = favoriteProjectToSeed({
    favoriteProjectId: null,
    favoriteOrgId: null,
    activeOrgId: "orgA",
  });
  assert.equal(projectId, null);
});
