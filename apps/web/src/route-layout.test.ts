import assert from "node:assert/strict";
import test from "node:test";
import { isDetailWorkspacePath } from "./route-layout.ts";

test("issue and incident detail routes use the full-width investigation workspace", () => {
  assert.equal(isDetailWorkspacePath("/issues/issue-1"), true);
  assert.equal(isDetailWorkspacePath("/incidents/incident-1"), true);
  assert.equal(isDetailWorkspacePath("/issues"), false);
  assert.equal(isDetailWorkspacePath("/settings"), false);
});
