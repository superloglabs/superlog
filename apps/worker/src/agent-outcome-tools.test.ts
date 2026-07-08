import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OUTCOME_TOOL_DEFINITIONS,
  OUTCOME_TOOL_NAMES,
  REPORT_FINDINGS_TOOL_NAME,
  TERMINAL_OUTCOME_TOOL_NAMES,
  assembleAgentRunResult,
  mergeFindings,
  validateOutcomeToolInput,
} from "./agent-outcome-tools.js";
import type { AgentRunFindings } from "./agent-outcome-tools.js";

const FINDINGS: AgentRunFindings = {
  summary: "Cart pricing requests time out under load.",
  proposedTitle: "Cart pricing requests time out during checkout",
  rootCause: "**api/pricing.ts:42**\n```ts\nfor (const item of items) await lookup(item)\n```",
  rootCauseConfidence: 9,
  estimatedImpact: "All checkout attempts with >10 items fail.",
  impactConfidence: 7,
  severity: "SEV-2",
  handoffNotes: "Checked the vendor API timeout config; it is not the cause.",
};

test("exposes all six tools with API-safe schemas", () => {
  assert.equal(OUTCOME_TOOL_NAMES.length, 6);
  assert.equal(OUTCOME_TOOL_DEFINITIONS.length, 6);
  for (const def of OUTCOME_TOOL_DEFINITIONS) {
    // Some runner APIs reject any top-level composition keyword
    // (allOf/oneOf/if...), which would block every run at agent-create time.
    assert.deepEqual(Object.keys(def.input_schema).sort(), ["properties", "required", "type"]);
    assert.equal(def.input_schema.type, "object");
    const propNames = Object.keys(def.input_schema.properties);
    for (const req of def.input_schema.required) {
      assert.ok(propNames.includes(req), `${def.name}: required ${req} missing from properties`);
    }
    assert.ok(def.description.length > 40, `${def.name}: description too short`);
  }
});

// The load-bearing guidance that moved out of the runner's system prompt into
// tool descriptions. Losing any of these regressed real agent behavior before
// (structural-only validation, behavior-changing "equivalent" refactors), so
// pin them here.
test("propose_pr description carries the validation ladder and refactor-equivalence rules", () => {
  const proposePr = OUTCOME_TOOL_DEFINITIONS.find((d) => d.name === "propose_pr");
  assert.ok(proposePr);
  const text = proposePr?.description ?? "";
  assert.ok(text.includes("Validation ladder"));
  assert.ok(text.includes("Structural checks"));
  assert.ok(text.includes("are NOT validation"));
  assert.ok(text.includes("behaviorally identical"));
  assert.ok(text.includes("first-wins vs last-wins"));
  assert.ok(text.includes("regression test"));
  assert.ok(text.includes("/mnt/session/outputs/superlog.patch"));
  const validationPassed = proposePr?.input_schema.properties.validationPassed as {
    description?: string;
  };
  assert.ok(validationPassed.description?.includes("honest false is acceptable"));
});

test("noise-outcome descriptions carry the per-reason evidentiary bars", () => {
  for (const name of ["silence_as_noise", "place_under_observation"]) {
    const def = OUTCOME_TOOL_DEFINITIONS.find((d) => d.name === name);
    const text = def?.description ?? "";
    for (const reason of [
      "cosmetic_log_only",
      "lifecycle_signal",
      "self_telemetry",
      "expected_third_party",
      "confusing_log_no_impact",
    ]) {
      assert.ok(text.includes(reason), `${name} missing ${reason}`);
    }
  }
  const silence = OUTCOME_TOOL_DEFINITIONS.find((d) => d.name === "silence_as_noise");
  assert.ok(silence?.description.includes("the bar is high"));
  assert.ok(silence?.description.includes("Do NOT propose code changes"));
});

test("marks exactly five tools terminal", () => {
  assert.equal(TERMINAL_OUTCOME_TOOL_NAMES.length, 5);
  assert.ok(!(TERMINAL_OUTCOME_TOOL_NAMES as readonly string[]).includes(REPORT_FINDINGS_TOOL_NAME));
});

// Sessions created against the old toolset can resume days later (e.g. from
// awaiting_human) and still call a retired tool. The validator must reject
// the call with redirect guidance so the model re-lands on a live outcome —
// falling through to the unknown-tool path would hard-fail the run instead.
test("rejects retired terminal tools with redirect guidance", () => {
  for (const name of ["complete_investigation", "report_failure"]) {
    const v = validateOutcomeToolInput(name, { disposition: "informational" }, { hasFindings: true });
    assert.equal(v.ok, false, name);
    if (!v.ok) {
      const text = v.errors.join(" ");
      assert.ok(text.includes("ask_human"), name);
      assert.ok(text.includes("propose_pr"), name);
    }
  }
});

test("accepts a full report_findings payload", () => {
  const v = validateOutcomeToolInput(REPORT_FINDINGS_TOOL_NAME, FINDINGS, { hasFindings: false });
  assert.equal(v.ok, true);
});

test("rejects report_findings without a summary", () => {
  const v = validateOutcomeToolInput(
    REPORT_FINDINGS_TOOL_NAME,
    { proposedTitle: "x" },
    { hasFindings: false },
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.errors.join(" "), /summary/);
});

test("clamps out-of-range confidences instead of rejecting", () => {
  const v = validateOutcomeToolInput(
    REPORT_FINDINGS_TOOL_NAME,
    { summary: "s", rootCauseConfidence: 14 },
    { hasFindings: false },
  );
  assert.equal(v.ok, true);
  if (v.ok) assert.equal((v.payload as AgentRunFindings).rootCauseConfidence, 10);
});

test("rejects a bad severity with a model-readable message", () => {
  const v = validateOutcomeToolInput(
    REPORT_FINDINGS_TOOL_NAME,
    { summary: "s", severity: "SEV-4" },
    { hasFindings: false },
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.errors.join(" ").includes("SEV-3"));
});

test("rejects silence_as_noise with an unknown reason, naming the valid enum", () => {
  const v = validateOutcomeToolInput(
    "silence_as_noise",
    { reason: "not_a_reason", evidence: "e" },
    { hasFindings: true },
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.errors.join(" ").includes("expected_third_party"));
});

test("requires findings before complete-family terminals", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["silence_as_noise", { reason: "cosmetic_log_only", evidence: "e" }],
    ["mark_already_resolved", { reason: "upstream_recovered", evidence: "e" }],
    [
      "place_under_observation",
      { reason: "cosmetic_log_only", evidence: "e", escalateOn: "additional_events", threshold: 10 },
    ],
    [
      "propose_pr",
      {
        repoFullName: "acme/shop",
        title: "[superlog] Fix",
        body: "# Summary",
        branchName: "superlog/fix",
        baseBranch: "main",
        patchFilePath: "/mnt/session/outputs/superlog.patch",
        validationPassed: true,
        validationSummary: "tests pass",
      },
    ],
  ];
  for (const [name, input] of cases) {
    const v = validateOutcomeToolInput(name, input, { hasFindings: false });
    assert.equal(v.ok, false, `${name} should require findings`);
    if (!v.ok) assert.ok(v.errors.join(" ").includes("report_findings"), name);
  }
});

test("allows ask_human without findings", () => {
  assert.equal(
    validateOutcomeToolInput("ask_human", { question: "which repo owns api-gw?" }, { hasFindings: false }).ok,
    true,
  );
});

test("validates place_under_observation trigger fields", () => {
  const bad = validateOutcomeToolInput(
    "place_under_observation",
    { reason: "cosmetic_log_only", evidence: "e", escalateOn: "hourly", threshold: 10 },
    { hasFindings: true },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.errors.join(" ").includes("events_per_minute"));

  const badThreshold = validateOutcomeToolInput(
    "place_under_observation",
    { reason: "cosmetic_log_only", evidence: "e", escalateOn: "additional_events", threshold: 0 },
    { hasFindings: true },
  );
  assert.equal(badThreshold.ok, false);
});

test("validates propose_pr required fields and branch prefix", () => {
  const v = validateOutcomeToolInput(
    "propose_pr",
    { repoFullName: "acme/shop", title: "t" },
    { hasFindings: true },
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.errors.join(" "), /branchName/);

  const badBranch = validateOutcomeToolInput(
    "propose_pr",
    {
      repoFullName: "acme/shop",
      title: "[superlog] Fix N+1",
      body: "# Summary",
      branchName: "claude/fix",
      baseBranch: "dev",
      patchFilePath: "/mnt/session/outputs/superlog.patch",
      validationPassed: true,
      validationSummary: "tests pass",
    },
    { hasFindings: true },
  );
  assert.equal(badBranch.ok, false);
  if (!badBranch.ok) assert.ok(badBranch.errors.join(" ").includes("superlog/"));
});

test("propose_pr mobile fields are conditionally required", () => {
  const base = {
    repoFullName: "acme/shop",
    title: "[superlog] Fix",
    body: "# Summary",
    branchName: "superlog/fix",
    baseBranch: "main",
    patchFilePath: "/mnt/session/outputs/superlog.patch",
    validationPassed: true,
    validationSummary: "tests pass",
  };
  const created = validateOutcomeToolInput(
    "propose_pr",
    { ...base, mobileTestStatus: "created" },
    { hasFindings: true },
  );
  assert.equal(created.ok, false);
  if (!created.ok) assert.match(created.errors.join(" "), /mobileTestId/);

  const skipped = validateOutcomeToolInput(
    "propose_pr",
    { ...base, mobileTestStatus: "skipped" },
    { hasFindings: true },
  );
  assert.equal(skipped.ok, false);
  if (!skipped.ok) assert.match(skipped.errors.join(" "), /mobileTestReason/);
});

test("rejects unknown tool names", () => {
  const v = validateOutcomeToolInput("submit_agent_run_result", {}, { hasFindings: true });
  assert.equal(v.ok, false);
});

test("mergeFindings is last-write-wins per defined field", () => {
  const a = mergeFindings(null, { summary: "first", severity: "SEV-3" });
  const b = mergeFindings(a, { summary: "second", rootCause: "rc" });
  assert.equal(b.summary, "second");
  assert.equal(b.severity, "SEV-3");
  assert.equal(b.rootCause, "rc");
});

test("assembles silence_as_noise into a complete result with a silence action", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "silence_as_noise",
      payload: { reason: "expected_third_party", evidence: "**a.ts:1**\n```ts\nx\n```" },
    },
  });
  assert.equal(result.state, "complete");
  assert.equal(result.summary, FINDINGS.summary);
  assert.equal(result.proposedTitle, FINDINGS.proposedTitle);
  assert.deepEqual(result.noiseClassification, {
    reason: "expected_third_party",
    evidence: "**a.ts:1**\n```ts\nx\n```",
    action: { kind: "silence" },
  });
  assert.equal(result.pr, undefined);
});

test("maps place_under_observation onto an observe action with a parsed trigger", () => {
  const rate = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "place_under_observation",
      payload: { reason: "lifecycle_signal", evidence: "e", escalateOn: "events_per_minute", threshold: 5 },
    },
  });
  assert.deepEqual(rate.noiseClassification?.action, {
    kind: "observe",
    trigger: { kind: "rate", perMinute: 5 },
  });

  const count = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "place_under_observation",
      payload: { reason: "lifecycle_signal", evidence: "e", escalateOn: "additional_events", threshold: 100 },
    },
  });
  assert.deepEqual(count.noiseClassification?.action, {
    kind: "observe",
    trigger: { kind: "count", count: 100 },
  });
});

test("maps mark_already_resolved onto resolutionClassification", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "mark_already_resolved",
      payload: { reason: "fixed_in_current_code", evidence: "e" },
    },
  });
  assert.equal(result.state, "complete");
  assert.deepEqual(result.resolutionClassification, {
    reason: "fixed_in_current_code",
    evidence: "e",
  });
});

test("assembles propose_pr into an AgentRunPr with pending openStatus", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "propose_pr",
      payload: {
        repoFullName: "acme/shop",
        title: "[superlog] Batch vendor lookups",
        body: "# Summary\n...",
        branchName: "superlog/batch-vendor-lookups",
        baseBranch: "dev",
        patchFilePath: "/mnt/session/outputs/superlog.patch",
        validationPassed: true,
        validationCommands: ["pnpm test"],
        validationSummary: "repro passes after fix",
        changedFiles: ["api/pricing.ts"],
        mobileTestStatus: "not_applicable",
        mobileTestReason: "backend-only change",
      },
    },
  });
  assert.equal(result.state, "complete");
  assert.equal(result.pr?.selectedRepoFullName, "acme/shop");
  assert.equal(result.pr?.branchName, "superlog/batch-vendor-lookups");
  assert.equal(result.pr?.baseBranch, "dev");
  assert.equal(result.pr?.patchFilePath, "/mnt/session/outputs/superlog.patch");
  assert.equal(result.pr?.validationPassed, true);
  assert.equal(result.pr?.openStatus, "pending");
  assert.deepEqual(result.pr?.validationCommands, ["pnpm test"]);
  assert.deepEqual(result.mobileRegressionTest, {
    status: "not_applicable",
    reason: "backend-only change",
  });
});

test("derives the legacy rootCauseConfidence bucket from the numeric confidence", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "mark_already_resolved",
      payload: { reason: "transient_condition_cleared", evidence: "e" },
    },
  });
  assert.deepEqual(result.rootCause, { text: FINDINGS.rootCause, confidence: 9 });
  assert.equal(result.rootCauseConfidence, "high");
  assert.deepEqual(result.estimatedImpact, { text: FINDINGS.estimatedImpact, confidence: 7 });
});

test("falls back to the question as summary when findings are absent", () => {
  const ask = assembleAgentRunResult({
    findings: null,
    terminal: { name: "ask_human", payload: { question: "Which repo owns api-gw?" } },
  });
  assert.equal(ask.state, "awaiting_human");
  assert.equal(ask.question, "Which repo owns api-gw?");
  assert.equal(ask.summary, "Which repo owns api-gw?");
});
