import assert from "node:assert/strict";
import test from "node:test";
import {
  ORG_NAV_GROUPS,
  PROJECT_NAV_GROUPS,
  nextOrgIdAfterDelete,
  nextProjectIdAfterDelete,
  projectPickerOptions,
  resolveOrgSection,
  resolveProjectSection,
  shouldShowProjectPicker,
} from "./nav.ts";

test("org nav: single flat group, weekly digest folded into general", () => {
  const ids: string[] = ORG_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, [
    "general",
    "members",
    "billing",
    "agent-guidance",
    "mgmt-keys",
    "github-install",
  ]);
  assert.equal(ORG_NAV_GROUPS.length, 1);
  assert.equal(ORG_NAV_GROUPS[0]?.label, undefined);
  assert.ok(!ids.includes("weekly-digest"));
});

test("project nav: single flat group, Install MCP sits next to MCP tokens", () => {
  const ids = PROJECT_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, [
    "general",
    "agent",
    "agent-memories",
    "integrations",
    "issue-filter",
    "slack-channel",
    "api-keys",
    "mcp-install",
    "mcp-tokens",
    "webhooks",
  ]);
  assert.equal(PROJECT_NAV_GROUPS.length, 1);
  assert.equal(PROJECT_NAV_GROUPS[0]?.label, undefined);
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

test("project picker is visible even before the first project exists", () => {
  assert.equal(shouldShowProjectPicker("project"), true);
  assert.equal(shouldShowProjectPicker("org"), false);
  assert.deepEqual(projectPickerOptions([]), [
    { value: "__new_project__", label: "+ New project", searchText: "new project" },
  ]);
});

test("project deletion selects a neighboring project for the URL", () => {
  const projects = [
    { id: "p1", name: "One" },
    { id: "p2", name: "Two" },
    { id: "p3", name: "Three" },
  ];

  assert.equal(nextProjectIdAfterDelete(projects, "p2"), "p3");
  assert.equal(nextProjectIdAfterDelete(projects, "p3"), "p2");
  assert.equal(nextProjectIdAfterDelete(projects, "p1"), "p2");
  assert.equal(nextProjectIdAfterDelete([{ id: "p1", name: "One" }], "p1"), undefined);
});

test("nextOrgIdAfterDelete picks the neighbour at the same position", () => {
  const orgs = [{ id: "o1" }, { id: "o2" }, { id: "o3" }];
  assert.equal(nextOrgIdAfterDelete(orgs, "o2"), "o3");
  assert.equal(nextOrgIdAfterDelete(orgs, "o3"), "o2");
  assert.equal(nextOrgIdAfterDelete(orgs, "o1"), "o2");
  assert.equal(nextOrgIdAfterDelete([{ id: "o1" }], "o1"), undefined);
  assert.equal(nextOrgIdAfterDelete(orgs, "missing"), "o1");
});
