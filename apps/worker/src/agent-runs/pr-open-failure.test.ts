import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizePrOpenFailure } from "./pr-open-failure.js";

test("summarizePrOpenFailure surfaces scrubbed public git detail", () => {
  const token = "ghs_AbCdEf0123456789AbCdEf0123456789";
  const err = Object.assign(new Error("git push origin HEAD failed with exit 1"), {
    publicDetail: `remote: ${token}\n! [rejected] HEAD -> branch (fetch first)`,
  });

  const summary = summarizePrOpenFailure(err);

  assert.match(summary, /^Failed to open the PR: remote: ghs_\*\*\*/);
  assert.ok(!summary.includes(token));
});

test("summarizePrOpenFailure falls back to the error message when no public detail exists", () => {
  assert.equal(
    summarizePrOpenFailure(new Error("git apply failed: patch does not apply")),
    "Failed to open the PR: git apply failed: patch does not apply",
  );
});

test("summarizePrOpenFailure keeps empty errors opaque", () => {
  assert.equal(summarizePrOpenFailure(new Error("")), "Failed to validate or open the PR.");
});
