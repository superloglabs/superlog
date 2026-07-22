import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISPATCHED_OUTCOME_TOOL_NAMES,
  OUTCOME_TOOL_DEFINITIONS,
  OUTCOME_TOOL_NAMES,
  REPORT_FINDINGS_TOOL_NAME,
  RETIRED_OUTCOME_TOOL_NAMES,
  TERMINAL_OUTCOME_TOOL_NAMES,
  assembleAgentRunResult,
  isDispatchedOutcomeToolName,
  mergeFindings,
  outcomeToolDefinitionsForCapabilities,
  validateLegacyOutcomeToolInput,
  validateOutcomeToolInput,
} from "./agent-outcome-tools.js";
import type {
  AgentRunFindings,
  ResolveIncidentIssueOutcome,
  ResolveIncidentPayload,
} from "./agent-outcome-tools.js";

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

const BATCH_PROPOSE_PR_INPUT = {
  pullRequests: [
    PROPOSE_PR_INPUT,
    {
      ...PROPOSE_PR_INPUT,
      repoFullName: "acme/worker",
      title: "[superlog] Align worker shutdown timeout",
      branchName: "superlog/align-worker-shutdown-timeout",
      patchFilePath: "/mnt/session/outputs/superlog-align-worker-shutdown-timeout.patch",
    },
  ],
};

test("validated observation outcomes require their escalation fields in the type", () => {
  // @ts-expect-error validated observation outcomes always require a trigger and threshold
  const invalid: ResolveIncidentIssueOutcome = {
    issueId: "issue-1",
    status: "under_observation",
    reason: "Watch for recurrence.",
    evidence: "The current window is healthy.",
  };
  assert.equal(invalid.status, "under_observation");
});

const RESOLVE_INCIDENT_INPUT = {
  reason: "The required work is complete and no further action is needed.",
  evidence: "The failing signal has remained at zero for 30 minutes.",
  issueOutcomes: [
    {
      issueId: "issue-1",
      status: "silenced",
      reason: "Expected bot probes have no user impact.",
      evidence: "The handler returned its documented no-op response.",
    },
    {
      issueId: "issue-2",
      status: "resolved",
      reason: "The merged change removed the failure mode.",
      evidence: "The error count stayed at zero after deployment.",
    },
  ],
} satisfies ResolveIncidentPayload;

test("propose_pr accepts one patch per repository and ends the turn without resolving", () => {
  const validation = validateOutcomeToolInput("propose_pr", BATCH_PROPOSE_PR_INPUT, {
    hasFindings: true,
  });
  assert.equal(validation.ok, true);
  if (!validation.ok || validation.tool !== "propose_pr") return;

  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: { name: "propose_pr", payload: validation.payload },
  });

  assert.equal(result.state, "awaiting_events");
  assert.equal(result.prs?.length, 2);
  assert.equal(result.prs?.[0]?.selectedRepoFullName, "acme/shop");
  assert.equal(result.prs?.[1]?.selectedRepoFullName, "acme/worker");
  assert.equal(result.incidentResolution, undefined);
});

test("exposes the desired outcome tools with API-safe schemas", () => {
  assert.deepEqual(
    [...OUTCOME_TOOL_NAMES],
    [
      "report_findings",
      "propose_pr",
      "complete_investigation",
      "ask_human",
      "report_external_cause",
      "resolve_incident",
    ],
  );
  assert.equal(OUTCOME_TOOL_DEFINITIONS.length, 5);
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

test("splits the contract into dispatched and terminal tools", () => {
  assert.deepEqual([...DISPATCHED_OUTCOME_TOOL_NAMES], ["propose_pr", "resolve_incident"]);
  assert.deepEqual(
    [...TERMINAL_OUTCOME_TOOL_NAMES],
    [
      "propose_pr",
      "complete_investigation",
      "ask_human",
      "report_external_cause",
      "resolve_incident",
    ],
  );
  assert.ok(
    !(TERMINAL_OUTCOME_TOOL_NAMES as readonly string[]).includes(REPORT_FINDINGS_TOOL_NAME),
  );
  assert.ok(isDispatchedOutcomeToolName("propose_pr"));
  assert.ok(isDispatchedOutcomeToolName("resolve_incident"));
  assert.ok(!isDispatchedOutcomeToolName("report_external_cause"));
});

test("offers complete_investigation whenever PR creation is unavailable", () => {
  const withPrs = outcomeToolDefinitionsForCapabilities({
    prCreation: true,
    approvalPrompts: false,
  }).map((definition) => definition.name);
  assert.ok(withPrs.includes("propose_pr"));
  assert.ok(!withPrs.includes("complete_investigation"));

  const findingsOnly = outcomeToolDefinitionsForCapabilities({
    prCreation: false,
    approvalPrompts: false,
  }).map((definition) => definition.name);
  assert.ok(!findingsOnly.includes("propose_pr"));
  assert.ok(findingsOnly.includes("complete_investigation"));

  const withApprovals = outcomeToolDefinitionsForCapabilities({
    prCreation: false,
    approvalPrompts: true,
  }).map((definition) => definition.name);
  assert.ok(withApprovals.includes("complete_investigation"));
  assert.ok(!withApprovals.includes("create_linear_issue"));
});

// The load-bearing guidance in tool descriptions. Losing any of these
// regressed real agent behavior before, so pin them.
test("propose_pr description explains the terminal multi-PR contract", () => {
  const proposePr = OUTCOME_TOOL_DEFINITIONS.find((d) => d.name === "propose_pr");
  assert.ok(proposePr);
  const text = proposePr?.description ?? "";
  assert.ok(text.includes("Terminal for this turn"));
  assert.ok(text.includes("one validated PR per repository"));
  assert.ok(text.includes("reusing the same repository and branchName"));
  assert.ok(text.includes("/mnt/session/outputs/"));
  // Noise guardrail must survive the rewrite.
  assert.ok(text.includes("NOT for noise"));
});

test("propose_pr title guidance defers to repository and organization conventions", () => {
  const proposePr = OUTCOME_TOOL_DEFINITIONS.find((definition) => definition.name === "propose_pr");
  assert.ok(proposePr);
  const pullRequests = proposePr.input_schema.properties.pullRequests;
  assert.ok(pullRequests);
  const item = pullRequests.items as {
    properties: Record<string, { description?: string }>;
  };
  const titleDescription = item.properties.title?.description ?? "";

  assert.match(titleDescription, /repository's agent-instruction files/i);
  assert.match(titleDescription, /organization-specific guidance/i);
  assert.doesNotMatch(titleDescription, /\[superlog\]/i);
});

test("resolve_incident description requires atomic per-issue outcomes", () => {
  const def = OUTCOME_TOOL_DEFINITIONS.find((d) => d.name === "resolve_incident");
  assert.ok(def?.description.includes("exactly one outcome for every linked Issue"));
  assert.ok(def?.description.includes("atomically"));
});

// Sessions created against an old toolset can resume days later and still
// call a retired tool. The validator must reject the call with redirect
// guidance so the model re-lands on a live outcome — falling through to the
// unknown-tool path would hard-fail the run instead.
test("rejects retired tools (incl. mark_already_resolved) with redirect guidance", () => {
  assert.ok((RETIRED_OUTCOME_TOOL_NAMES as readonly string[]).includes("mark_already_resolved"));
  for (const name of RETIRED_OUTCOME_TOOL_NAMES.filter(
    (toolName) => toolName !== "create_linear_issue",
  )) {
    const v = validateOutcomeToolInput(
      name,
      { reason: "upstream_recovered", evidence: "e" },
      { hasFindings: true },
    );
    assert.equal(v.ok, false, name);
    if (!v.ok) {
      const text = v.errors.join(" ");
      assert.ok(text.includes("resolve_incident"), name);
      assert.ok(text.includes("issueOutcomes"), name);
    }
  }
});

test("maps legacy create_linear_issue calls to deterministic completion", () => {
  const validation = validateOutcomeToolInput("create_linear_issue", {}, { hasFindings: true });
  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.equal(validation.tool, "complete_investigation");
    assert.deepEqual(validation.payload, {});
  }
});

test("keeps the findings gate for legacy create_linear_issue calls", () => {
  const validation = validateOutcomeToolInput("create_linear_issue", {}, { hasFindings: false });
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.match(validation.errors.join(" "), /report_findings/);
});

test("validates immutable legacy resolve calls without relaxing the advertised contract", () => {
  assert.ok(!isDispatchedOutcomeToolName("resolve_issue"));
  const legacyResolve = validateLegacyOutcomeToolInput(
    "resolve_incident",
    {
      reason: "All classified issues are complete.",
      evidence: "The failing signal has remained at zero for 30 minutes.",
    },
    { hasFindings: true },
  );
  assert.equal(legacyResolve.ok, true);
  if (legacyResolve.ok) assert.equal(legacyResolve.tool, "resolve_incident");

  const strictResolve = validateOutcomeToolInput(
    "resolve_incident",
    {
      reason: "All classified issues are complete.",
      evidence: "The failing signal has remained at zero for 30 minutes.",
    },
    { hasFindings: true },
  );
  assert.equal(strictResolve.ok, false);
  if (!strictResolve.ok) assert.match(strictResolve.errors.join(" "), /issueOutcomes/);
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

test("requires findings before findings-backed terminal tools", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["propose_pr", PROPOSE_PR_INPUT],
    ["resolve_incident", RESOLVE_INCIDENT_INPUT],
    [
      "report_external_cause",
      {
        cause: "quota exhausted",
        source: "Vendor",
        evidence: "402",
        recommendedNextStep: "top up",
      },
    ],
    ["complete_investigation", {}],
  ];
  for (const [name, input] of cases) {
    const v = validateOutcomeToolInput(name, input, { hasFindings: false });
    assert.equal(v.ok, false, `${name} should require findings`);
    if (!v.ok) assert.ok(v.errors.join(" ").includes("report_findings"), name);
  }
});

test("complete_investigation finishes without resolving the incident", () => {
  const validation = validateOutcomeToolInput("complete_investigation", {}, { hasFindings: true });
  assert.equal(validation.ok, true);

  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: { name: "complete_investigation", payload: {} },
  });
  assert.equal(result.state, "complete");
  assert.equal(result.completionKind, "investigation_complete");
  assert.equal(result.incidentResolution, undefined);
});

test("allows ask_human without findings", () => {
  assert.equal(
    validateOutcomeToolInput(
      "ask_human",
      { question: "which repo owns api-gw?" },
      { hasFindings: false },
    ).ok,
    true,
  );
});

test("validates resolve_incident issue outcomes", () => {
  const accepted = validateOutcomeToolInput("resolve_incident", RESOLVE_INCIDENT_INPUT, {
    hasFindings: true,
  });
  assert.equal(accepted.ok, true);

  const duplicate = validateOutcomeToolInput(
    "resolve_incident",
    {
      ...RESOLVE_INCIDENT_INPUT,
      issueOutcomes: [
        RESOLVE_INCIDENT_INPUT.issueOutcomes[0],
        { ...RESOLVE_INCIDENT_INPUT.issueOutcomes[0] },
      ],
    },
    { hasFindings: true },
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.errors.join(" "), /duplicate/i);

  const invalidObservation = validateOutcomeToolInput(
    "resolve_incident",
    {
      ...RESOLVE_INCIDENT_INPUT,
      issueOutcomes: [
        {
          issueId: "issue-1",
          status: "under_observation",
          reason: "one-off",
          evidence: "single occurrence",
          escalateOn: "additional_events",
          threshold: 0,
        },
      ],
    },
    { hasFindings: true },
  );
  assert.equal(invalidObservation.ok, false);
  if (!invalidObservation.ok) assert.match(invalidObservation.errors.join(" "), /threshold/);

  const strayObservationFields = validateOutcomeToolInput(
    "resolve_incident",
    {
      ...RESOLVE_INCIDENT_INPUT,
      issueOutcomes: [
        {
          issueId: "issue-1",
          status: "resolved",
          reason: "done",
          evidence: "zero failures",
          escalateOn: "additional_events",
          threshold: 1,
        },
      ],
    },
    { hasFindings: true },
  );
  assert.equal(strayObservationFields.ok, false);
  if (!strayObservationFields.ok)
    assert.match(strayObservationFields.errors.join(" "), /forbidden/);
});

test("resolve_incident accepts an empty outcome set for zero-Issue incidents", () => {
  const definition = OUTCOME_TOOL_DEFINITIONS.find((item) => item.name === "resolve_incident");
  assert.ok(definition);
  assert.equal(definition.input_schema.properties.issueOutcomes?.minItems, undefined);

  const validation = validateOutcomeToolInput(
    "resolve_incident",
    {
      reason: "The delegated investigation is complete.",
      evidence: "The external ticket reached its completed state.",
      issueOutcomes: [],
    },
    { hasFindings: true },
  );
  assert.equal(validation.ok, true);
});

test("report_external_cause records why the open incident is waiting", () => {
  const validation = validateOutcomeToolInput(
    "report_external_cause",
    {
      cause: "The provider rejected requests because the account balance is exhausted.",
      source: "Recall.ai",
      evidence: "The API returned HTTP 402 with an insufficient-credit error.",
      recommendedNextStep: "Top up the provider balance, then retry bot creation.",
    },
    { hasFindings: true },
  );
  assert.equal(validation.ok, true);
  if (!validation.ok || validation.tool !== "report_external_cause") return;

  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: { name: "report_external_cause", payload: validation.payload },
  });
  assert.equal(result.state, "awaiting_events");
  assert.equal(result.waitReason, "external_cause");
  assert.deepEqual(result.externalCause, validation.payload);
  assert.equal(result.incidentResolution, undefined);
  assert.equal(result.issueClassifications, undefined);
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

test("propose_pr rejects a JSON-encoded pullRequests string with array guidance", () => {
  const result = validateOutcomeToolInput(
    "propose_pr",
    { pullRequests: JSON.stringify([PROPOSE_PR_INPUT]) },
    { hasFindings: true },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(" "), /actual JSON array/i);
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

test("assembles resolve_incident issue outcomes into a complete result", () => {
  const resolutionEventDedupeKey = "incident_resolved:agent_run:run-1:resolve_incident:tool-use-1";
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "resolve_incident",
      payload: RESOLVE_INCIDENT_INPUT,
    },
    incidentResolutionEventDedupeKey: resolutionEventDedupeKey,
  });
  assert.equal(result.state, "complete");
  assert.equal(result.summary, FINDINGS.summary);
  assert.equal(result.proposedTitle, FINDINGS.proposedTitle);
  assert.deepEqual(result.incidentResolution, {
    reason: RESOLVE_INCIDENT_INPUT.reason,
    evidence: RESOLVE_INCIDENT_INPUT.evidence,
  });
  assert.equal(result.incidentResolutionEventDedupeKey, resolutionEventDedupeKey);
  assert.equal(result.issueClassifications?.length, 2);
  assert.deepEqual(result.issueClassifications?.[0], {
    issueId: "issue-1",
    action: "silence",
    reason: "Expected bot probes have no user impact.",
    evidence: "The handler returned its documented no-op response.",
  });
  assert.equal(result.prs, undefined);
});

test("observe outcome carries the parsed escalation trigger", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "resolve_incident",
      payload: {
        reason: "No remediation is needed unless this grows.",
        evidence: "One event occurred and no users were affected.",
        issueOutcomes: [
          {
            issueId: "issue-1",
            status: "under_observation",
            reason: "one-off",
            evidence: "e",
            escalateOn: "additional_events",
            threshold: 100,
          },
        ],
      },
    },
  });
  assert.deepEqual(result.issueClassifications?.[0]?.trigger, { kind: "count", count: 100 });
});

test("keeps legacy action-only turns readable while durable sessions drain", () => {
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

test("each proposed PR retains its own mobile regression decision", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: {
      name: "propose_pr",
      payload: {
        pullRequests: [
          {
            ...PROPOSE_PR_INPUT,
            changedFiles: ["app/checkout.tsx"],
            mobileTestStatus: "not_applicable",
            mobileTestReason: "backend-only change",
          },
          {
            ...PROPOSE_PR_INPUT,
            repoFullName: "acme/mobile",
            patchFilePath: "/mnt/session/outputs/mobile.patch",
            changedFiles: ["ios/CheckoutView.swift"],
            mobileTestStatus: "created",
            mobileTestId: "test-mobile-1",
          },
        ],
      },
    },
  });
  assert.deepEqual(result.mobileRegressionTest, {
    status: "created",
    testId: "test-mobile-1",
  });
  assert.deepEqual(result.prs?.[0]?.changedFiles, ["app/checkout.tsx"]);
  assert.deepEqual(result.prs?.[0]?.mobileRegressionTest, {
    status: "not_applicable",
    reason: "backend-only change",
  });
  assert.deepEqual(result.prs?.[1]?.mobileRegressionTest, {
    status: "created",
    testId: "test-mobile-1",
  });
});

test("derives the legacy rootCauseConfidence bucket from the numeric confidence", () => {
  const result = assembleAgentRunResult({
    findings: FINDINGS,
    terminal: { name: "resolve_incident", payload: RESOLVE_INCIDENT_INPUT },
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
