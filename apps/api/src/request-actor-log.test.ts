import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildActorLogFields, isMutatingMethod } from "./request-actor-log.js";

test("isMutatingMethod flags state-changing verbs case-insensitively", () => {
  for (const m of ["POST", "put", "Patch", "DELETE"]) {
    assert.equal(isMutatingMethod(m), true, `${m} should be mutating`);
  }
  for (const m of ["GET", "head", "OPTIONS"]) {
    assert.equal(isMutatingMethod(m), false, `${m} should not be mutating`);
  }
});

test("buildActorLogFields carries human-readable user + org identity", () => {
  assert.deepEqual(
    buildActorLogFields({
      method: "post",
      path: "/api/auth/organization/update-member-role",
      status: 403,
      userId: "user_123",
      userName: "Nicolo Magnante",
      userEmail: "nicolo@superlog.sh",
      orgId: "org_abc",
      orgName: "Superlog prod",
      orgSlug: "swish",
      sessionId: "sess_1",
      impersonating: false,
    }),
    {
      method: "POST",
      path: "/api/auth/organization/update-member-role",
      status: 403,
      userId: "user_123",
      userName: "Nicolo Magnante",
      userEmail: "nicolo@superlog.sh",
      orgId: "org_abc",
      orgName: "Superlog prod",
      orgSlug: "swish",
      sessionId: "sess_1",
      impersonating: false,
    },
  );
});

test("buildActorLogFields defaults missing org / session fields to null", () => {
  const fields = buildActorLogFields({
    method: "DELETE",
    path: "/api/projects/p1",
    status: 200,
    userId: "user_9",
  });
  assert.equal(fields.orgId, null);
  assert.equal(fields.orgName, null);
  assert.equal(fields.orgSlug, null);
  assert.equal(fields.userName, null);
  assert.equal(fields.userEmail, null);
  assert.equal(fields.sessionId, null);
  assert.equal(fields.impersonating, false);
});
