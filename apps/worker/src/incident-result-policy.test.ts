import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import {
  completedNoiseReason,
  completedResolutionReason,
  noiseReasonLabel,
  normalizeNoiseReason,
  normalizeResolutionReason,
  normalizeSeverity,
  resolutionReasonLabel,
} from "./incident-result-policy.js";

test("normalizeSeverity accepts canonical severities with case and whitespace noise", () => {
  assert.equal(normalizeSeverity("SEV-1"), "SEV-1");
  assert.equal(normalizeSeverity(" sev - 2 "), "SEV-2");
  assert.equal(normalizeSeverity("sev-3"), "SEV-3");
});

test("normalizeSeverity rejects unknown or non-string inputs", () => {
  assert.equal(normalizeSeverity("SEV-4"), null);
  assert.equal(normalizeSeverity("sev2"), null);
  assert.equal(normalizeSeverity(null), null);
  assert.equal(normalizeSeverity(2), null);
});

test("normalizes incident result reason enums from agent output", () => {
  assert.equal(normalizeNoiseReason(" SELF_TELEMETRY "), "self_telemetry");
  assert.equal(normalizeNoiseReason("confusing_log_no_impact"), "confusing_log_no_impact");
  assert.equal(normalizeNoiseReason("not_a_noise_reason"), null);
  assert.equal(normalizeNoiseReason(undefined), null);

  assert.equal(normalizeResolutionReason(" UPSTREAM_RECOVERED "), "upstream_recovered");
  assert.equal(
    normalizeResolutionReason("transient_condition_cleared"),
    "transient_condition_cleared",
  );
  assert.equal(normalizeResolutionReason("not_a_resolution_reason"), null);
  assert.equal(normalizeResolutionReason({}), null);
});

test("reason labels stay human-readable for Slack and incident history", () => {
  assert.equal(noiseReasonLabel("cosmetic_log_only"), "cosmetic log only");
  assert.equal(noiseReasonLabel("lifecycle_signal"), "lifecycle signal");
  assert.equal(noiseReasonLabel("self_telemetry"), "self-telemetry");
  assert.equal(noiseReasonLabel("expected_third_party"), "expected third-party response");
  assert.equal(noiseReasonLabel("confusing_log_no_impact"), "recovered/no impact");

  assert.equal(resolutionReasonLabel("fixed_in_current_code"), "fixed in current code");
  assert.equal(
    resolutionReasonLabel("transient_condition_cleared"),
    "transient condition cleared",
  );
  assert.equal(resolutionReasonLabel("upstream_recovered"), "upstream recovered");
});

test("completed reason helpers only read classifications from complete results", () => {
  const complete = {
    state: "complete",
    noiseClassification: { reason: "LIFECYCLE_SIGNAL" },
    resolutionClassification: { reason: "FIXED_IN_CURRENT_CODE" },
  } as unknown as AgentRunResult;
  const running = {
    state: "running",
    noiseClassification: { reason: "self_telemetry" },
    resolutionClassification: { reason: "upstream_recovered" },
  } as unknown as AgentRunResult;

  assert.equal(completedNoiseReason(complete), "lifecycle_signal");
  assert.equal(completedResolutionReason(complete), "fixed_in_current_code");
  assert.equal(completedNoiseReason(running), null);
  assert.equal(completedResolutionReason(running), null);
});
