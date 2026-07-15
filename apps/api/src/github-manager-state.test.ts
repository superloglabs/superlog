import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

process.env.BETTER_AUTH_SECRET ??= "github-manager-state-test-better-auth-secret";

const { signGithubWebState, verifyGithubWebState } = await import("./github.js");

const SECRET = "github-manager-state-test-secret";

test("GitHub web install state binds both the project and initiating manager", () => {
  const state = signGithubWebState({ projectId: "project-1", userId: "manager-1" }, SECRET);

  assert.deepEqual(verifyGithubWebState(state, SECRET), {
    projectId: "project-1",
    userId: "manager-1",
  });
  assert.equal(verifyGithubWebState(state, "wrong-secret"), null);
});

test("GitHub web install state rejects legacy project-only capabilities", () => {
  const legacyPayload = `web.project-1.${Date.now()}`;
  const signature = crypto.createHmac("sha256", SECRET).update(legacyPayload).digest("base64url");
  const state = `${Buffer.from(legacyPayload).toString("base64url")}.${signature}`;

  assert.equal(verifyGithubWebState(state, SECRET), null);
});

test("GitHub web install state rejects a malformed signature without throwing", () => {
  const state = signGithubWebState({ projectId: "project-1", userId: "manager-1" }, SECRET);
  const [payload] = state.split(".");

  assert.equal(verifyGithubWebState(`${payload}.x`, SECRET), null);
});
