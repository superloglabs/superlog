import assert from "node:assert/strict";
import { test } from "node:test";
import { assessPatchValidation } from "./validation-gate.js";

function pr(overrides: Partial<Parameters<typeof assessPatchValidation>[0]> = {}) {
  return {
    validationPassed: true,
    validationCommands: ["pnpm vitest run src/worker.test.ts"],
    validationSummary: "42 tests passed.",
    ...overrides,
  };
}

test("accepts a result whose validation executed real commands and passed", () => {
  const verdict = assessPatchValidation(pr());
  assert.equal(verdict.ok, true);
});

test("rejects when the agent itself reported validationPassed=false", () => {
  const verdict = assessPatchValidation(pr({ validationPassed: false }));
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /validationPassed/);
});

test("rejects when every validation command is a structural grep/string check", () => {
  const verdict = assessPatchValidation(
    pr({
      validationCommands: [
        "grep -n 'retryLimit' src/worker.ts",
        "rg 'newField' -l src/",
        "cat src/worker.ts | grep retryLimit",
      ],
    }),
  );
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /structural/i);
});

test("does not split on shell operators inside quoted arguments", () => {
  const verdict = assessPatchValidation(
    pr({
      validationCommands: [
        'grep -n "retry|fallback" src/worker.ts',
        "grep -n 'a && b; c' src/worker.ts",
      ],
    }),
  );
  assert.equal(verdict.ok, false);
});

test("handles escaped quotes inside double-quoted arguments", () => {
  // \" inside double quotes does not close the quote — the | stays quoted.
  const verdict = assessPatchValidation(
    pr({ validationCommands: ['grep -n "say \\"hi|bye\\"" src/worker.ts'] }),
  );
  assert.equal(verdict.ok, false);
});

test("backslash does not escape inside single quotes", () => {
  // 'a\' closes at the second quote; the | after it is a real pipe between
  // two structural commands.
  const verdict = assessPatchValidation(
    pr({ validationCommands: ["echo 'a\\' | grep b src/worker.ts"] }),
  );
  assert.equal(verdict.ok, false);
});

test("treats read-only git inspection as structural", () => {
  const verdict = assessPatchValidation(
    pr({ validationCommands: ["git diff --stat", "git log --oneline -5"] }),
  );
  assert.equal(verdict.ok, false);
});

test("accepts a mix of structural checks and an executed test command", () => {
  const verdict = assessPatchValidation(
    pr({
      validationCommands: [
        "grep -n 'retryLimit' src/worker.ts",
        "pnpm vitest run src/worker.test.ts",
      ],
    }),
  );
  assert.equal(verdict.ok, true);
});

test("strips env prefixes and shell chaining when classifying commands", () => {
  assert.equal(
    assessPatchValidation(pr({ validationCommands: ["NODE_ENV=test pnpm test"] })).ok,
    true,
  );
  assert.equal(
    assessPatchValidation(
      pr({ validationCommands: ["cd app && NODE_ENV=test grep -c foo src/x.ts"] }),
    ).ok,
    false,
  );
});

test("fails open on commands it cannot classify", () => {
  const verdict = assessPatchValidation(pr({ validationCommands: ["./scripts/repro.sh"] }));
  assert.equal(verdict.ok, true);
});

test("fails open when no validation commands were listed", () => {
  assert.equal(assessPatchValidation(pr({ validationCommands: undefined })).ok, true);
  assert.equal(assessPatchValidation(pr({ validationCommands: [] })).ok, true);
});

test("rejects when the validation summary records its own failed command", () => {
  const verdict = assessPatchValidation(
    pr({ validationSummary: "pnpm tsc --noEmit → ❌ exit 1 (pre-existing type errors)" }),
  );
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /fail/i);
});

test("rejects failure markers written in exit-code prose", () => {
  const verdict = assessPatchValidation(
    pr({ validationSummary: "vitest exited with code 2 ✗ — see output above" }),
  );
  assert.equal(verdict.ok, false);
});

test("accepts summaries that mention exit 0 or passing checks", () => {
  assert.equal(
    assessPatchValidation(pr({ validationSummary: "✅ pnpm test exit 0, 42 passed" })).ok,
    true,
  );
  assert.equal(
    assessPatchValidation(
      pr({ validationSummary: "Repro failed before the fix and passes after." }),
    ).ok,
    true,
  );
});
