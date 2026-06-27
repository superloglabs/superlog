import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAgentResult } from "./managed-agent-result.js";

test("rejects non-object input", () => {
  const r = normalizeAgentResult("not an object");
  assert.equal(r.ok, false);
});

test("rejects when required state is missing", () => {
  const r = normalizeAgentResult({ summary: "x" });
  assert.equal(r.ok, false);
});

test("rejects when state is not in the enum", () => {
  const r = normalizeAgentResult({ state: "in_progress", summary: "x" });
  assert.equal(r.ok, false);
});

test("accepts result when summary is missing, synthesises fallback and records drop", () => {
  const r = normalizeAgentResult({ state: "complete" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(typeof r.result.summary, "string");
  assert.ok(r.result.summary.length > 0);
  assert.ok(r.drops.includes("summary"));
});

test("accepts result when summary is non-string, synthesises fallback from proposedTitle and records drop", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: 42,
    proposedTitle: "Alert evaluation fails due to ClickHouse drops",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.result.summary.includes("Alert evaluation fails due to ClickHouse drops"));
  assert.ok(r.drops.includes("summary"));
});

test("accepts minimal well-formed result", () => {
  const r = normalizeAgentResult({ state: "complete", summary: "all good" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.state, "complete");
  assert.equal(r.result.summary, "all good");
  assert.deepEqual(r.drops, []);
});

test("normalizes handoffNotes and drops non-string values", () => {
  const ok = normalizeAgentResult({
    state: "complete",
    summary: "x",
    handoffNotes: "Examined apps/api/src/billing.ts; ruled out the retry path (idempotent).",
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(
    ok.result.handoffNotes,
    "Examined apps/api/src/billing.ts; ruled out the retry path (idempotent).",
  );
  assert.deepEqual(ok.drops, []);

  const bad = normalizeAgentResult({ state: "complete", summary: "x", handoffNotes: 42 });
  assert.equal(bad.ok, true);
  if (!bad.ok) return;
  assert.equal(bad.result.handoffNotes, undefined);
  assert.deepEqual(bad.drops, ["handoffNotes"]);
});

test("accepts a fully-populated well-formed result", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    question: null,
    failureReason: null,
    proposedTitle: "Better title",
    rootCauseConfidence: "high",
    rootCause: { text: "because", confidence: 9 },
    estimatedImpact: { text: "blocks signup", confidence: 7 },
    severity: "SEV-2",
    mobileRegressionTest: {
      status: "created",
      testId: "test_123",
      url: "https://app.revyl.ai/tests/test_123",
    },
    noiseClassification: null,
    resolutionClassification: null,
    pr: {
      selectedRepoFullName: "org/repo",
      branchName: "superlog/fix",
      baseBranch: "main",
      title: "[superlog] Fix the broken flow",
      body: "# Summary\nFixes the broken flow.",
      validationPassed: true,
      openStatus: "pending",
      patchFilePath: "/mnt/session/outputs/superlog.patch",
      validationCommands: ["pnpm test"],
      changedFiles: ["src/a.ts"],
    },
    linearTicket: {
      id: "TEAM-123",
      url: "https://linear.app/t/TEAM-123",
      createdByAgent: true,
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.rootCause?.text, "because");
  assert.equal(r.result.rootCause?.confidence, 9);
  assert.equal(r.result.estimatedImpact?.confidence, 7);
  assert.equal(r.result.severity, "SEV-2");
  assert.equal(r.result.mobileRegressionTest?.status, "created");
  assert.equal(r.result.mobileRegressionTest?.testId, "test_123");
  assert.equal(r.result.pr?.branchName, "superlog/fix");
  assert.equal(r.result.pr?.title, "[superlog] Fix the broken flow");
  assert.equal(r.result.pr?.body, "# Summary\nFixes the broken flow.");
  assert.equal(r.result.linearTicket?.id, "TEAM-123");
  assert.deepEqual(r.drops, []);
});

test("accepts skipped mobile regression test decision with a reason", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    mobileRegressionTest: {
      status: "skipped",
      reason: "The fix changes a backend-only webhook and has no reliable mobile UI flow.",
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.mobileRegressionTest?.status, "skipped");
  assert.match(r.result.mobileRegressionTest?.reason ?? "", /backend-only webhook/);
  assert.deepEqual(r.drops, []);
});

test("accepts stringified mobile regression test decisions", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    mobileRegressionTest: JSON.stringify({
      status: "created",
      testId: "test_123",
      url: "https://app.revyl.ai/tests/test_123",
    }),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.mobileRegressionTest?.status, "created");
  assert.equal(r.result.mobileRegressionTest?.testId, "test_123");
  assert.equal(r.result.mobileRegressionTest?.url, "https://app.revyl.ai/tests/test_123");
  assert.deepEqual(r.drops, []);
});

test("drops malformed mobile regression test decisions", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    mobileRegressionTest: {
      status: "created",
      reason: "created cannot omit testId",
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.mobileRegressionTest, undefined);
  assert.deepEqual(r.drops, ["mobileRegressionTest"]);
});

test("drops malformed estimatedImpact (flat string instead of object) — repro of fae38dd9 incident", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    estimatedImpact: '\n<parameter name="text">PrivyAuthSync is...',
    rootCause: '\n<parameter name="text">`PrivyAuthSync` decides...',
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.estimatedImpact, undefined);
  assert.equal(r.result.rootCause, undefined);
  assert.deepEqual(r.drops.sort(), ["estimatedImpact", "rootCause"]);
});

test("drops confidence object missing fields", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    rootCause: { text: "no confidence here" },
    estimatedImpact: { confidence: 5 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.rootCause, undefined);
  assert.equal(r.result.estimatedImpact, undefined);
  assert.deepEqual(r.drops.sort(), ["estimatedImpact", "rootCause"]);
});

test("clamps confidence to 0-10 range and rounds", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    rootCause: { text: "a", confidence: 15.6 },
    estimatedImpact: { text: "b", confidence: -3 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.rootCause?.confidence, 10);
  assert.equal(r.result.estimatedImpact?.confidence, 0);
});

test("rejects non-finite confidence (NaN, Infinity)", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    rootCause: { text: "a", confidence: Number.NaN },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.rootCause, undefined);
  assert.deepEqual(r.drops, ["rootCause"]);
});

test("drops invalid severity and rootCauseConfidence enums", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    severity: "SEV-0",
    rootCauseConfidence: "maybe",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.severity, undefined);
  assert.equal(r.result.rootCauseConfidence, undefined);
  assert.deepEqual(r.drops.sort(), ["rootCauseConfidence", "severity"]);
});

test("drops invalid failureReason when state=complete", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    failureReason: "something_else",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.failureReason, undefined);
  assert.deepEqual(r.drops, ["failureReason"]);
});

test("rejects state=failed without a valid failureReason", () => {
  const r = normalizeAgentResult({
    state: "failed",
    summary: "x",
    failureReason: "something_else",
  });
  assert.equal(r.ok, false);
});

test("rejects state=failed when failureReason is missing", () => {
  const r = normalizeAgentResult({ state: "failed", summary: "x" });
  assert.equal(r.ok, false);
});

test("accepts state=failed with a valid failureReason", () => {
  const r = normalizeAgentResult({
    state: "failed",
    summary: "x",
    failureReason: "agent_no_findings",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.failureReason, "agent_no_findings");
});

test("rejects state=awaiting_human without a question", () => {
  const r = normalizeAgentResult({ state: "awaiting_human", summary: "x" });
  assert.equal(r.ok, false);
});

test("rejects state=awaiting_human with empty question", () => {
  const r = normalizeAgentResult({
    state: "awaiting_human",
    summary: "x",
    question: "",
  });
  assert.equal(r.ok, false);
});

test("accepts state=awaiting_human with a question", () => {
  const r = normalizeAgentResult({
    state: "awaiting_human",
    summary: "x",
    question: "Which repo owns this code path?",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.question, "Which repo owns this code path?");
});

test("keeps explicit null on optional field without reporting drop", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    rootCause: null,
    estimatedImpact: null,
    pr: null,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.drops, []);
});

test("drops PR missing required fields", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    pr: {
      branchName: "superlog/fix",
      baseBranch: "main",
      validationPassed: true,
      openStatus: "pending",
      // missing selectedRepoFullName
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.pr, undefined);
  assert.deepEqual(r.drops, ["pr"]);
});

test("accepts PR when the agent accidentally submits it as a JSON string", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    pr: JSON.stringify({
      selectedRepoFullName: "org/repo",
      branchName: "superlog/fix",
      baseBranch: "main",
      title: "[superlog] Allow members to access projects outside the active org",
      body: "# Summary\nUsers get an 'Unauthorized' error.\n\n[Incident on Superlog](https://superlog.sh/incidents/inc-1)",
      validationPassed: true,
      openStatus: "pending",
      patchFilePath: "/mnt/session/outputs/superlog.patch",
      changedFiles: ["src/a.ts"],
    }),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(
    r.result.pr?.title,
    "[superlog] Allow members to access projects outside the active org",
  );
  assert.match(r.result.pr?.body ?? "", /Unauthorized/);
  assert.deepEqual(r.drops, []);
});

test("accepts PR when a stringified object has one extra trailing brace", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    pr: `${JSON.stringify({
      selectedRepoFullName: "org/repo",
      branchName: "superlog/fix",
      baseBranch: "main",
      title: "[superlog] Allow members to access projects outside the active org",
      body: "# Summary\nUsers get an 'Unauthorized' error.",
      validationPassed: true,
      openStatus: "pending",
      patchFilePath: "/mnt/session/outputs/superlog.patch",
    })}}`,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.pr?.selectedRepoFullName, "org/repo");
  assert.equal(
    r.result.pr?.title,
    "[superlog] Allow members to access projects outside the active org",
  );
  assert.deepEqual(r.drops, []);
});

test("drops PR with invalid openStatus", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    pr: {
      selectedRepoFullName: "org/repo",
      branchName: "superlog/fix",
      baseBranch: "main",
      validationPassed: true,
      openStatus: "merged",
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.pr, undefined);
  assert.deepEqual(r.drops, ["pr"]);
});

test("drops PR string array field with non-string entries but keeps the PR", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    pr: {
      selectedRepoFullName: "org/repo",
      branchName: "superlog/fix",
      baseBranch: "main",
      validationPassed: true,
      openStatus: "pending",
      changedFiles: ["a.ts", 42],
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.pr?.selectedRepoFullName, "org/repo");
  assert.equal(r.result.pr?.changedFiles, undefined);
});

test("drops noiseClassification with unknown reason", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    noiseClassification: { reason: "user_error", evidence: "x" },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.noiseClassification, undefined);
  assert.deepEqual(r.drops, ["noiseClassification"]);
});

test("drops linearTicket missing required createdByAgent", () => {
  const r = normalizeAgentResult({
    state: "complete",
    summary: "x",
    linearTicket: { id: "TEAM-1", url: null },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.linearTicket, undefined);
  assert.deepEqual(r.drops, ["linearTicket"]);
});
