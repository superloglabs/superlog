import assert from "node:assert/strict";
import test from "node:test";
import {
  ORG_NAV_GROUPS,
  PROJECT_NAV_GROUPS,
  resolveOrgSection,
  resolveProjectSection,
} from "./nav.ts";

test("org nav groups: main group then More group, weekly digest folded into general", () => {
  const ids: string[] = ORG_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, [
    "general",
    "members",
    "billing",
    "agent-guidance",
    "mgmt-keys",
    "github-install",
  ]);
  assert.equal(ORG_NAV_GROUPS[0]?.label, undefined);
  assert.equal(ORG_NAV_GROUPS[1]?.label, "More");
  assert.ok(!ids.includes("weekly-digest"));
});

test("project nav groups: agent pages before integrations, keys/webhooks under More", () => {
  const ids = PROJECT_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, [
    "general",
    "agent",
    "agent-memories",
    "integrations",
    "issue-filter",
    "slack-channel",
    "api-keys",
    "webhooks",
  ]);
  assert.equal(PROJECT_NAV_GROUPS[1]?.label, "More");
});

test("every org nav id resolves to itself", () => {
  for (const g of ORG_NAV_GROUPS) {
    for (const item of g.items) {
      assert.equal(resolveOrgSection(item.id), item.id);
    }
  }
});

test("every project nav id resolves to itself", () => {
  for (const g of PROJECT_NAV_GROUPS) {
    for (const item of g.items) {
      assert.equal(resolveProjectSection(item.id), item.id);
    }
  }
});

test("legacy weekly-digest URLs land on org general", () => {
  assert.equal(resolveOrgSection("weekly-digest"), "general");
});

test("unknown or missing sections fall back to general", () => {
  assert.equal(resolveOrgSection("nope"), "general");
  assert.equal(resolveOrgSection(undefined), "general");
  assert.equal(resolveProjectSection("nope"), "general");
  assert.equal(resolveProjectSection(undefined), "general");
});

test("cross-scope section ids don't leak across resolvers", () => {
  assert.equal(resolveOrgSection("webhooks"), "general");
  assert.equal(resolveProjectSection("mgmt-keys"), "general");
});
