import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildActorLogFields,
  isAuditableMutation,
  isMutatingMethod,
  isReadOnlyPostPath,
} from "./request-actor-log.js";

test("isMutatingMethod flags state-changing verbs case-insensitively", () => {
  for (const m of ["POST", "put", "Patch", "DELETE"]) {
    assert.equal(isMutatingMethod(m), true, `${m} should be mutating`);
  }
  for (const m of ["GET", "head", "OPTIONS"]) {
    assert.equal(isMutatingMethod(m), false, `${m} should not be mutating`);
  }
});

test("isReadOnlyPostPath treats Explore queries, lookups and previews as reads", () => {
  for (const p of [
    "/api/projects/p1/explore/logs",
    "/api/projects/p1/explore/traces",
    "/api/projects/p1/explore/metric-series?foo=bar",
    "/api/projects/p1/issues/lookup",
    "/api/projects/p1/issue-filter/preview",
    "/api/projects/p1/alerts/preview",
  ]) {
    assert.equal(isReadOnlyPostPath(p), true, `${p} should be read-only`);
  }
  for (const p of [
    "/api/projects/p1/keys",
    "/api/projects/p1/dashboards",
    "/api/auth/organization/update-member-role",
    "/api/me/orgs",
  ]) {
    assert.equal(isReadOnlyPostPath(p), false, `${p} should not be read-only`);
  }
});

test("isAuditableMutation excludes read POSTs but keeps real writes", () => {
  assert.equal(
    isAuditableMutation({ method: "POST", path: "/api/projects/p1/explore/logs" }),
    false,
  );
  assert.equal(isAuditableMutation({ method: "GET", path: "/api/projects/p1/keys" }), false);
  assert.equal(isAuditableMutation({ method: "POST", path: "/api/projects/p1/keys" }), true);
  assert.equal(
    isAuditableMutation({ method: "POST", path: "/api/auth/organization/update-member-role" }),
    true,
  );
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
      impersonatedBy: null,
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
      impersonatedBy: null,
    },
  );
});

test("buildActorLogFields surfaces the impersonator so staff actions are traceable", () => {
  const fields = buildActorLogFields({
    method: "POST",
    path: "/api/projects/p1/context",
    status: 200,
    userId: "customer_1",
    impersonatedBy: "staff_9",
  });
  assert.equal(fields.userId, "customer_1");
  assert.equal(fields.impersonatedBy, "staff_9");
  assert.equal(fields.impersonating, true);
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
  assert.equal(fields.impersonatedBy, null);
});
