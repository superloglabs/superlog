// Publication gate for agent-authored patches.
//
// The agent validates its own patch inside its session sandbox and reports
// the outcome (`validationPassed`, `validationCommands`, `validationSummary`).
// The worker trusts those fields — it deliberately does not execute
// agent-authored commands (see applyPatchAndOpenPr). That trust has been
// abused in practice: results arrived with validationPassed=true backed only
// by grep/string-presence checks, or with a literal "❌ exit 1" recorded in
// their own validation summary. This module is the mechanical backstop the
// system prompt's "validation is execution" rule cannot provide on its own:
// it inspects the *reported* evidence and refuses to publish a PR when that
// evidence is absent, structural-only, or self-contradictory.
//
// Deliberately fail-open: commands we cannot classify (project scripts,
// reproduction binaries) count as real validation. The gate only blocks
// clear-cut cases.

import type { schema } from "@superlog/db";

export type PatchValidationVerdict = { ok: true } | { ok: false; reason: string };

// Programs that inspect text or repo state without executing the patched
// code. A validation made up exclusively of these proves the patch is
// *present*, not that it *works*. Read-only git inspection is included; shell
// plumbing (cd, export, true) is included so `cd app && grep …` doesn't pass
// as executed validation on the strength of the `cd`.
const STRUCTURAL_PROGRAMS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "cat",
  "ls",
  "find",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "echo",
  "printf",
  "which",
  "type",
  "tree",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "diff",
  "strings",
  "git",
  "cd",
  "pushd",
  "popd",
  "export",
  "true",
  "test",
  "[",
]);

// A failure the agent recorded about its OWN validation: a ❌/✗ marker on the
// same line as a non-zero exit code, in either order. Kept narrow on purpose —
// "repro failed before the fix and passes after" is a legitimate narrative and
// must not trip the gate.
const RECORDED_FAILURE =
  /(?:❌|✗)[^\n]*\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*[:= ]?\s*[1-9]\d*\b|\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*[:= ]?\s*[1-9]\d*\b[^\n]*(?:❌|✗)/iu;

function segmentPrograms(command: string): string[] {
  return command
    .split(/\|\|?|&&|;/)
    .map((segment) => {
      const tokens = segment.trim().split(/\s+/);
      let i = 0;
      // Skip leading VAR=value environment assignments.
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i += 1;
      const head = tokens[i] ?? "";
      return head.split("/").pop() ?? "";
    })
    .filter((program) => program.length > 0);
}

export function isStructuralCommand(command: string): boolean {
  const programs = segmentPrograms(command);
  if (programs.length === 0) return true;
  return programs.every((program) => STRUCTURAL_PROGRAMS.has(program));
}

export function assessPatchValidation(
  pr: Pick<schema.AgentRunPr, "validationPassed" | "validationCommands" | "validationSummary">,
): PatchValidationVerdict {
  if (pr.validationPassed !== true) {
    return {
      ok: false,
      reason: "The agent reported validationPassed=false — its own validation did not pass.",
    };
  }

  const evidence = [...(pr.validationCommands ?? []), pr.validationSummary ?? ""].join("\n");
  if (RECORDED_FAILURE.test(evidence)) {
    return {
      ok: false,
      reason:
        "The reported validation records a failed command (non-zero exit) — the patch cannot be published on failing validation.",
    };
  }

  const commands = pr.validationCommands ?? [];
  if (commands.length > 0 && commands.every(isStructuralCommand)) {
    return {
      ok: false,
      reason:
        "Every reported validation command is a structural text/grep check; none executed the patched code (build, tests, or reproduction).",
    };
  }

  return { ok: true };
}
