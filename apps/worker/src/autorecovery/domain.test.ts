import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CandidateIncident,
  type ProposalToolInput,
  buildInitialUserMessage,
  buildProposalSlackBlocks,
  buildProposalSlackText,
  clampLookbackHours,
  decideProposalOutcome,
  parseProposalToolInput,
} from "./domain.js";
import {
  type AutorecoveryPolicy,
  compareConfidence,
  decideThrottle,
  meetsConfidence,
} from "./policy.js";

function makeCandidate(overrides: Partial<CandidateIncident> = {}): CandidateIncident {
  return {
    id: "inc-1",
    projectId: "proj-1",
    title: "Database connection refused",
    codename: "purple-otter",
    service: "api",
    firstSeen: new Date("2026-05-22T10:00:00Z"),
    lastSeen: new Date("2026-05-23T02:00:00Z"),
    issueCount: 3,
    issueSignatures: [{ exceptionType: "Error" }],
    slackChannelId: null,
    slackThreadTs: null,
    slackInstallationId: null,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ProposalToolInput> = {}): ProposalToolInput {
  return {
    looks_resolved: true,
    confidence: "medium",
    reason_code: "external dependency recovered",
    reason_text: "Downstream service has been responsive for several hours.",
    ...overrides,
  };
}

test("parseProposalToolInput accepts a valid proposal", () => {
  const out = parseProposalToolInput({
    looks_resolved: true,
    confidence: "high",
    reason_code: " external dependency recovered ",
    reason_text: " Looks fine now ",
    evidence_summary: " 0 events / 24h ",
  });
  assert.deepEqual(out, {
    looks_resolved: true,
    confidence: "high",
    reason_code: "external dependency recovered",
    reason_text: "Looks fine now",
    evidence_summary: "0 events / 24h",
  });
});

test("parseProposalToolInput rejects malformed inputs", () => {
  assert.equal(parseProposalToolInput(null), null);
  assert.equal(parseProposalToolInput("hello"), null);
  assert.equal(parseProposalToolInput({}), null);
  assert.equal(
    parseProposalToolInput({
      looks_resolved: "yes",
      confidence: "high",
      reason_code: "x",
      reason_text: "x",
    }),
    null,
  );
  assert.equal(
    parseProposalToolInput({
      looks_resolved: true,
      confidence: "definitely",
      reason_code: "x",
      reason_text: "x",
    }),
    null,
  );
  assert.equal(
    parseProposalToolInput({
      looks_resolved: true,
      confidence: "low",
      reason_code: "",
      reason_text: "x",
    }),
    null,
  );
  assert.equal(
    parseProposalToolInput({
      looks_resolved: true,
      confidence: "low",
      reason_code: "x",
      reason_text: "   ",
    }),
    null,
  );
});

test("parseProposalToolInput omits evidence_summary when not a string", () => {
  const out = parseProposalToolInput({
    looks_resolved: false,
    confidence: "low",
    reason_code: "stopped recurring unknown cause",
    reason_text: "no evidence one way or the other",
    evidence_summary: 42,
  });
  assert.equal(out?.evidence_summary, undefined);
});

test("clampLookbackHours bounds input to [1, 168] and defaults to 24", () => {
  assert.equal(clampLookbackHours(undefined), 24);
  assert.equal(clampLookbackHours(null), 24);
  assert.equal(clampLookbackHours({}), 24);
  assert.equal(clampLookbackHours({ hours: "12" }), 24);
  assert.equal(clampLookbackHours({ hours: Number.NaN }), 24);
  assert.equal(clampLookbackHours({ hours: 0 }), 1);
  assert.equal(clampLookbackHours({ hours: -10 }), 1);
  assert.equal(clampLookbackHours({ hours: 5.7 }), 5);
  assert.equal(clampLookbackHours({ hours: 200 }), 168);
});

test("compareConfidence orders low < medium < high", () => {
  assert.ok(compareConfidence("low", "medium") < 0);
  assert.ok(compareConfidence("medium", "low") > 0);
  assert.ok(compareConfidence("high", "medium") > 0);
  assert.equal(compareConfidence("medium", "medium"), 0);
});

test("meetsConfidence checks the floor", () => {
  assert.equal(meetsConfidence("medium", "low"), true);
  assert.equal(meetsConfidence("medium", "medium"), true);
  assert.equal(meetsConfidence("medium", "high"), false);
  assert.equal(meetsConfidence("low", "medium"), false);
});

test("decideProposalOutcome routes to propose / skip variants", () => {
  assert.equal(
    decideProposalOutcome(makeProposal({ looks_resolved: false }), "medium").kind,
    "skip_not_resolved",
  );
  assert.equal(
    decideProposalOutcome(makeProposal({ confidence: "low" }), "medium").kind,
    "skip_below_confidence",
  );
  assert.equal(
    decideProposalOutcome(makeProposal({ confidence: "medium" }), "medium").kind,
    "propose",
  );
  assert.equal(
    decideProposalOutcome(makeProposal({ confidence: "high" }), "medium").kind,
    "propose",
  );
});

test("decideThrottle: no prior run always runs", () => {
  const out = decideThrottle(null, new Date(), { intervalMs: 1000 });
  assert.equal(out.kind, "run");
});

test("decideThrottle: too-soon skip", () => {
  const last = new Date("2026-05-23T09:00:00Z");
  const now = new Date("2026-05-23T09:30:00Z");
  const out = decideThrottle(last, now, { intervalMs: 60 * 60 * 1000 });
  assert.equal(out.kind, "skip");
  if (out.kind === "skip") {
    assert.equal(out.reason, "interval");
    assert.equal(out.sinceMs, 30 * 60 * 1000);
  }
});

test("decideThrottle: past-interval runs", () => {
  const last = new Date("2026-05-23T09:00:00Z");
  const now = new Date("2026-05-23T11:00:00Z");
  const out = decideThrottle(last, now, { intervalMs: 60 * 60 * 1000 });
  assert.equal(out.kind, "run");
});

test("buildInitialUserMessage includes hoursSinceLastSeen derived from now", () => {
  const incident = makeCandidate({
    lastSeen: new Date("2026-05-23T00:00:00Z"),
  });
  const msg = buildInitialUserMessage(incident, new Date("2026-05-23T06:00:00Z"));
  assert.ok(msg.includes('"hoursSinceLastSeen": 6'));
  assert.ok(msg.includes('"codename": "purple-otter"'));
});

test("buildProposalSlackBlocks embeds proposal id into action ids", () => {
  const blocks = buildProposalSlackBlocks("prop-42", makeProposal());
  const json = JSON.stringify(blocks);
  assert.ok(json.includes("resolve_proposal_confirm:prop-42"));
  assert.ok(json.includes("resolve_proposal_dismiss:prop-42"));
  assert.ok(json.includes("medium confidence"));
  assert.ok(json.includes("external dependency recovered"));
});

test("buildProposalSlackText embeds reason_text verbatim", () => {
  const text = buildProposalSlackText(makeProposal({ reason_text: "everything is fine now" }));
  assert.equal(text, ":white_check_mark: This incident looks resolved — everything is fine now");
});

// Sanity: AutorecoveryPolicy type still composes with concrete values.
test("AutorecoveryPolicy is constructible from object literal", () => {
  const policy: AutorecoveryPolicy = {
    intervalMs: 1000,
    skipRecentActivityMs: 1000,
    skipRecentlyCreatedMs: 1000,
    dismissalCooldownMs: 1000,
    reevaluationCooldownMs: 1000,
    maxCandidatesPerTick: 5,
    proposeMinConfidence: "medium",
    maxAgentIterations: 4,
  };
  assert.equal(policy.proposeMinConfidence, "medium");
});
