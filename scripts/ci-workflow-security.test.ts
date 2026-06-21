import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yaml", import.meta.url), "utf8");

test("CI workflow uses least-privilege repository token permissions", () => {
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(workflow, /^permissions:\s*write-all$/m);
});

test("CI workflow pins third-party actions to immutable commit SHAs", () => {
  const actionRefs = [...workflow.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/gm)];

  assert.ok(actionRefs.length > 0, "expected workflow to use at least one action");

  for (const [, action, ref] of actionRefs) {
    assert.match(ref, /^[a-f0-9]{40}$/, `${action} is not pinned to a full commit SHA`);
  }
});

test("CI workflow checkout steps do not persist GitHub token credentials", () => {
  const checkoutBlocks = workflow
    .split(/\n(?=\s+- name: )/)
    .filter((block) => block.includes("uses: actions/checkout@"));

  assert.ok(checkoutBlocks.length > 0, "expected workflow to use checkout");

  for (const block of checkoutBlocks) {
    assert.match(block, /\n\s+persist-credentials:\s*false\b/);
  }
});
