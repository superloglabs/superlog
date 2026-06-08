import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeRepoBranches, prBaseBranchExists } from "./github-branches.js";

test("mergeRepoBranches dedupes across repos, marks defaults, and sorts defaults first", () => {
  const merged = mergeRepoBranches([
    { defaultBranch: "main", branches: ["main", "dev", "feature/x"] },
    { defaultBranch: "master", branches: ["master", "dev"] },
  ]);
  assert.deepEqual(merged, [
    { name: "main", isDefault: true },
    { name: "master", isDefault: true },
    { name: "dev", isDefault: false },
    { name: "feature/x", isDefault: false },
  ]);
});

test("mergeRepoBranches treats a branch as default if it is the default in any repo", () => {
  const merged = mergeRepoBranches([
    { defaultBranch: null, branches: ["dev"] },
    { defaultBranch: "dev", branches: ["dev"] },
  ]);
  assert.deepEqual(merged, [{ name: "dev", isDefault: true }]);
});

test("mergeRepoBranches includes the default branch even if absent from the branch list", () => {
  const merged = mergeRepoBranches([{ defaultBranch: "main", branches: [] }]);
  assert.deepEqual(merged, [{ name: "main", isDefault: true }]);
});

test("mergeRepoBranches ignores blank names and trims", () => {
  const merged = mergeRepoBranches([{ defaultBranch: "  ", branches: ["  ", " dev "] }]);
  assert.deepEqual(merged, [{ name: "dev", isDefault: false }]);
});

test("prBaseBranchExists allows blank (uses repository default)", () => {
  const branches = [{ name: "main", isDefault: true }];
  assert.equal(prBaseBranchExists(null, branches), true);
  assert.equal(prBaseBranchExists("", branches), true);
  assert.equal(prBaseBranchExists("   ", branches), true);
});

test("prBaseBranchExists requires a non-blank branch to be present", () => {
  const branches = [
    { name: "main", isDefault: true },
    { name: "dev", isDefault: false },
  ];
  assert.equal(prBaseBranchExists("dev", branches), true);
  assert.equal(prBaseBranchExists(" dev ", branches), true);
  assert.equal(prBaseBranchExists("nope", branches), false);
});
