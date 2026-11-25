import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeAutumnRequest, autumnRouteChangesBilling } from "./autumn-billing-access.js";

const roles = (role: string | null) => async () => role;

test("Autumn routes that only read billing are open to members", () => {
  for (const route of [
    "getOrCreateCustomer",
    "getEntity",
    "listPlans",
    "listEvents",
    "aggregateEvents",
    "previewAttach",
    "previewUpdateSubscription",
    "previewMultiAttach",
  ]) {
    assert.equal(autumnRouteChangesBilling(`/autumn/${route}`), false, route);
  }
});

test("every other Autumn route changes billing", () => {
  for (const route of [
    "attach",
    "multiAttach",
    "updateSubscription",
    "openCustomerPortal",
    "setupPayment",
    "createReferralCode",
    "redeemReferralCode",
    "someFutureRoute",
  ]) {
    assert.equal(autumnRouteChangesBilling(`/autumn/${route}`), true, route);
  }
});

test("members cannot change billing", async () => {
  await assert.rejects(
    authorizeAutumnRequest(
      { activeOrgId: "org-1", path: "/autumn/updateSubscription", userId: "user-1" },
      roles("member"),
    ),
    /Only org owners and admins can change billing/,
  );
});

test("owners and admins can change billing", async () => {
  for (const role of ["owner", "admin"]) {
    await authorizeAutumnRequest(
      { activeOrgId: "org-1", path: "/autumn/attach", userId: "user-1" },
      roles(role),
    );
  }
});

test("members can read billing", async () => {
  await authorizeAutumnRequest(
    { activeOrgId: "org-1", path: "/autumn/getOrCreateCustomer", userId: "user-1" },
    roles("member"),
  );
});

test("billing of an org the user does not belong to is refused", async () => {
  for (const request of [
    { activeOrgId: "org-1", path: "/autumn/getOrCreateCustomer", userId: "user-1" },
    { activeOrgId: null, path: "/autumn/listPlans", userId: "user-1" },
    { activeOrgId: "org-1", path: "/autumn/listPlans", userId: null },
  ]) {
    await assert.rejects(authorizeAutumnRequest(request, roles(null)), /not a member/);
  }
});

test("the role is read for the org the plugin bills", async () => {
  const lookups: Array<[string, string]> = [];
  await authorizeAutumnRequest(
    { activeOrgId: "org-1", path: "/autumn/attach", userId: "user-1" },
    async (userId, orgId) => {
      lookups.push([userId, orgId]);
      return "owner";
    },
  );
  assert.deepEqual(lookups, [["user-1", "org-1"]]);
});
