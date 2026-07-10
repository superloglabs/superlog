import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTION_OUTCOME_TOOL_NAMES,
  OUTCOME_TOOL_DEFINITIONS,
  OUTCOME_TOOL_NAMES,
  REPORT_FINDINGS_TOOL_NAME,
  RETIRED_OUTCOME_TOOL_NAMES,
  TERMINAL_OUTCOME_TOOL_NAMES,
  assembleAgentRunResult,
  isActionOutcomeToolName,
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

const PROPOSE_PR_INPUT = {
  repoFullName: "acme/shop",
  title: "[superlog] Batch vendor lookups",
  body: "# Summary\n...",
  branchName: "superlog/batch-vendor-lookups",
  baseBranch: "dev",
  patchFilePath: "/mnt/session/outputs/superlog-batch-vendor-lookups.patch",
};

test("exposes all seven tools with API-safe schemas", () => {
  assert.equal(OUTCOME_TOOL_NAMES.length, 7);
  assert.equal(OUTCOME_TOOL_DEFINITIONS.length, 7);
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

test("splits the contract into action tools and exactly two terminal tools", () => {
  assert.deepEqual(
    [...ACTION_OUTCOME_TOOL_NAMES],
    ["propose_pr", "silence_as_noise", "place_under_observation", "resolve_issue"],
  );
  assert.deepEqual([...TERMINAL_OUTCOME_TOOL_NAMES], ["resolve_incident", "ask_human"]);
  assert.ok(!(TERMINAL_OUTCOME_TOOL_NAMES as readonly string[]).includes(REPORT_FINDINGS_TOOL_NAME));
  assert.ok(isActionOutcomeToolName("propose_pr"));
  assert.ok(!isActionOutcomeToolName("resolve_incident"));
});

// The load-bearing guidance in tool descriptions. Losing any of these
// regressed real agent behavior before, so pin them.
test("propose_pr description explains the non-terminal multi-PR contract", () => {
  const proposePr = OUTCOME_TOOL_DEFINITIONS.find((d) => d.name === "propose_pr");
  assert.ok(proposePr);
  const text = proposePr?.description ?? "";
  assert.ok(text.includes("NOT terminal"));
  assert.ok(text.includes("NEW branchName"));
  assert.ok(text.includes("SAME branchName"));
  assert.ok(text.includes("/mnt/session/outputs/"));
  // Noise guardrail must survive the rewrite.
  assert.ok(text.includes("NOT for noise"));
});

test("silence_as_noise keeps the evidentiary bar and the no-quieting-PRs rule", () => {
  const silence = OUTCOME_TOOL_DEFINITIONS.find((d) => d.name === "silence_as_noise");
  assert.ok(silence?.description.includes("the bar is high"));
  assert.ok(silence?.description.includes("Do NOT propose code changes"));
  assert.ok(silence?.description.includes("resolve_issue"));
});

test("resolve_incident description requires per-issue classification first", () => {
  const def = OUTCOME_TOOL_DEFINITIONS.find((d) => d.name === "resolve_incident");
  assert.ok(def?.description.includes("Every issue linked"));
});

// Sessions created against an old toolset can resume days later and still
// call a retired tool. The validator must reject the call with redirect
// guidance so the model re-lands on a live outcome — falling through to the
// unknown-tool path would hard-fail the run instead.
test("rejects retired tools (incl. mark_already_resolved) with redirect guidance", () => {
  assert.ok((RETIRED_OUTCOME_TOOL_NAMES as readonly string[]).includes("mark_already_resolved"));
  for (const name of RETIRED_OUTCOME_TOOL_NAMES) {
    const v = validateOutcomeToolInput(name, { reason: "upstream_recovered", evidence: "e" }, { hasFindings: true });
    assert.equal(v.ok, false, name);
    if (!v.ok) {
      const text = v.errors.join(" ");
      assert.ok(text.includes("resolve_incident"), name);
      assert.ok(text.includes("resolve_issue"), name);
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

test("classification tools take free-text reasons and require issueId", () => {
  const ok = validateOutcomeToolInput(
    "silence_as_noise",
    { issueId: "issue-1", reason: "Expected 404s from bot traffic probing /wp-admin", evidence: "e" },
    { hasFindings: true },
  );
  assert.equal(ok.ok, true);

  const missingIssue = validateOutcomeToolInput(
    "silence_as_noise",
    { reason: "noise", evidence: "e" },
    { hasFindings: true },
  );
  assert.equal(missingIssue.ok, false);
  if (!missingIssue.ok) assert.match(missingIssue.errors.join(" "), /issueId/);

  const resolveOk = validateOutcomeToolInput(
    "resolve_issue",
    { issueId: "issue-2", reason: "Fixed by the merged retry-guard PR", evidence: "e" },
    { hasFindings: true },
  );
  assert.equal(resolveOk.ok, true);
});

test("requires findings before action tools and resolve_incident", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["silence_as_noise", { issueId: "i", reason: "noise", evidence: "e" }],
    ["resolve_issue", { issueId: "i", reason: "recovered", evidence: "e" }],
    [
      "place_under_observation",
      { issueId: "i", reason: "one-off", evidence: "e", escalateOn: "additional_events", threshold: 10 },
    ],
    ["propose_pr", PROPOSE_PR_INPUT],
    ["resolve_incident", { reason: "all done", evidence: "e" }],
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
    { issueId: "i", reason: "one-off", evidence: "e", escalateOn: "hourly", threshold: 10 },
    { hasFindings: true },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.errors.join(" ").includes("events_per_minute"));

  const badThreshold = validateOutcomeToolInput(
    "place_under_observation",
    { issueId: "i", reason: "one-off", evidence: "e", escalateOn: "additional_events", threshold: 0 },
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
    { ...PROPOSE_PR_INPUT, branchName: "claude/fix" },
    { hasFindings: true },
  );
  assert.equal(badBranch.ok, false);
  if (!badBranch.ok) assert.ok(badBranch.errors.join(" ").includes("superlog/"));
});

// Legacy sessions still send validationPassed; an honest false meant "do not
// open this PR" and must keep being honored.
test("propose_pr rejects a legacy validationPassed=false", () => {
  const v = validateOutcomeToolInput(
    "propose_pr",
    { ...PROPOSE_PR_INPUT, validationPassed: false },
    { hasFindings: true },
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.errors.join(" "), /validation/i);
});

test("propose_pr accepts legacy validation fields without carrying them", () => {
  const v = validateOutcomeToolInput(
    "propose_pr",
    { ...PROPOSE_PR_INPUT, validationPassed: true, validationSummary: "tests pass" },
    { hasFindings: true },
  );
  assert.equal(v.ok, true);
});

test("propose_pr mobile fields are conditionally required", () => {
  const created = validateOutcomeToolInput(
    "propose_pr",
    { ...PROPOSE_PR_INPUT, mobileTestStatus: "created" },
    { hasFindings: true },
  );
  assert.equal(created.ok, false);
  if (!created.ok) assert.match(created.errors.join(" "), /mobileTestId/);

  const skipped = validateOutcomeToolInput(
    "propose_pr",
    { ...PROPOSE_PR_INPUT, mobileTestStatus: "skipped" },
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

test("assembles resolve_incident with executed actions into a complete result", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "resolve_incident",
      payload: { reason: "PR merged and error rate back to zero", evidence: "e" },
    },
    actions: [
      {
        name: "silence_as_noise",
        payload: { issueId: "issue-1", reason: "bot probe noise", evidence: "e1" },
      },
      {
        name: "resolve_issue",
        payload: { issueId: "issue-2", reason: "fixed by the merged PR", evidence: "e2" },
      },
      { name: "propose_pr", payload: PROPOSE_PR_INPUT },
    ],
  });
  assert.equal(result.state, "complete");
  assert.equal(result.summary, FINDINGS.summary);
  assert.equal(result.proposedTitle, FINDINGS.proposedTitle);
  assert.deepEqual(result.incidentResolution, {
    reason: "PR merged and error rate back to zero",
    evidence: "e",
  });
  assert.equal(result.issueClassifications?.length, 2);
  assert.deepEqual(result.issueClassifications?.[0], {
    issueId: "issue-1",
    action: "silence",
    reason: "bot probe noise",
    evidence: "e1",
  });
  assert.equal(result.prs?.length, 1);
  assert.equal(result.prs?.[0]?.branchName, "superlog/batch-vendor-lookups");
  assert.equal(result.prs?.[0]?.openStatus, "opened");
  // Old readers get the singular field pointed at the most recent PR.
  assert.equal(result.pr?.branchName, "superlog/batch-vendor-lookups");
});

test("latest classification per issue wins and same-branch PRs collapse", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: { name: "resolve_incident", payload: { reason: "r", evidence: "e" } },
    actions: [
      {
        name: "place_under_observation",
        payload: {
          issueId: "issue-1",
          reason: "one-off",
          evidence: "e",
          escalateOn: "events_per_minute",
          threshold: 5,
        },
      },
      {
        name: "resolve_issue",
        payload: { issueId: "issue-1", reason: "actually fixed", evidence: "e" },
      },
      { name: "propose_pr", payload: PROPOSE_PR_INPUT },
      { name: "propose_pr", payload: { ...PROPOSE_PR_INPUT, title: "[superlog] Follow-up" } },
    ],
  });
  assert.equal(result.issueClassifications?.length, 1);
  assert.equal(result.issueClassifications?.[0]?.action, "resolve");
  assert.equal(result.prs?.length, 1);
  assert.equal(result.prs?.[0]?.title, "[superlog] Follow-up");
});

test("observe classification carries the parsed escalation trigger", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: { name: "resolve_incident", payload: { reason: "r", evidence: "e" } },
    actions: [
      {
        name: "place_under_observation",
        payload: {
          issueId: "issue-1",
          reason: "one-off",
          evidence: "e",
          escalateOn: "additional_events",
          threshold: 100,
        },
      },
    ],
  });
  assert.deepEqual(result.issueClassifications?.[0]?.trigger, { kind: "count", count: 100 });
});

test("assembles a parked awaiting_events result when no terminal call happened", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: null,
    actions: [{ name: "propose_pr", payload: PROPOSE_PR_INPUT }],
  });
  assert.equal(result.state, "awaiting_events");
  assert.equal(result.summary, FINDINGS.summary);
  assert.equal(result.prs?.length, 1);
  assert.equal(result.incidentResolution, undefined);
});

test("propose_pr mobile decision lands on the result", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: { name: "resolve_incident", payload: { reason: "r", evidence: "e" } },
    actions: [
      {
        name: "propose_pr",
        payload: {
          ...PROPOSE_PR_INPUT,
          changedFiles: ["app/checkout.tsx"],
          mobileTestStatus: "not_applicable",
          mobileTestReason: "backend-only change",
        },
      },
    ],
  });
  assert.deepEqual(result.mobileRegressionTest, {
    status: "not_applicable",
    reason: "backend-only change",
  });
  assert.deepEqual(result.prs?.[0]?.changedFiles, ["app/checkout.tsx"]);
});

test("derives the legacy rootCauseConfidence bucket from the numeric confidence", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: { name: "resolve_incident", payload: { reason: "r", evidence: "e" } },
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
