import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachCandidatesToPicks,
  buildDigestBlocks,
  buildRankingUserMessage,
  type DigestCandidate,
  parsePicks,
  severityEmoji,
  TOP_N,
  trivialPicks,
} from "./domain.js";

function makeCandidate(overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    agentRunId: "run-1",
    incidentId: "inc-1",
    incidentCodename: "purple-otter",
    incidentTitle: "DB unreachable",
    projectName: "Acme",
    service: "api",
    severity: "SEV-2",
    completedAt: new Date("2026-05-22T10:00:00Z"),
    summary: "Reconnect logic missed transient ECONNREFUSED",
    rootCause: "missing retry loop in pool acquire",
    estimatedImpact: "checkout broken for 2% of users",
    pr: {
      id: "pr-1",
      repoFullName: "acme/api",
      number: 42,
      title: "fix: reconnect on ECONNREFUSED",
      url: "https://github.com/acme/api/pull/42",
      branch: "fix/reconnect",
      baseBranch: "main",
      openedAt: new Date("2026-05-22T11:00:00Z"),
    },
    ...overrides,
  };
}

test("severityEmoji distinguishes SEV-1/2/3 and unset", () => {
  assert.equal(severityEmoji("SEV-1"), ":rotating_light:");
  assert.equal(severityEmoji("SEV-2"), ":warning:");
  assert.equal(severityEmoji("SEV-3"), ":small_orange_diamond:");
  assert.equal(severityEmoji(null), ":hammer_and_wrench:");
  assert.equal(severityEmoji("anything else"), ":hammer_and_wrench:");
});

test("buildRankingUserMessage serialises candidates as JSON with the fields the prompt expects", () => {
  const msg = buildRankingUserMessage([makeCandidate()]);
  assert.ok(msg.includes("Open bug-fix PRs to rank"));
  assert.ok(msg.includes("\"agentRunId\": \"run-1\""));
  assert.ok(msg.includes("\"severity\": \"SEV-2\""));
  // Dates serialised as ISO strings.
  assert.ok(msg.includes("\"completedAt\": \"2026-05-22T10:00:00.000Z\""));
});

test("parsePicks: valid JSON yields ordered picks (capped at TOP_N, dedup)", () => {
  const raw = JSON.stringify({
    picks: [
      { agentRunId: "a", rationale: "important" },
      { agentRunId: "a", rationale: "duplicate" },
      { agentRunId: "b", rationale: "next" },
      { agentRunId: "c", rationale: "third" },
      { agentRunId: "d", rationale: "fourth would be dropped" },
    ],
  });
  const picks = parsePicks(raw, new Set(["a", "b", "c", "d"]));
  assert.equal(picks.length, TOP_N);
  assert.deepEqual(
    picks.map((p) => p.agentRunId),
    ["a", "b", "c"],
  );
});

test("parsePicks: drops picks with unknown agentRunId or missing rationale", () => {
  const raw = JSON.stringify({
    picks: [
      { agentRunId: "ghost", rationale: "unknown id" },
      { agentRunId: "real", rationale: "" },
      { agentRunId: "real", rationale: " trimmed " },
    ],
  });
  const picks = parsePicks(raw, new Set(["real"]));
  assert.deepEqual(picks, [{ agentRunId: "real", rationale: "trimmed" }]);
});

test("parsePicks: invalid JSON or wrong shape yields empty array", () => {
  assert.deepEqual(parsePicks("not json", new Set()), []);
  assert.deepEqual(parsePicks("123", new Set()), []);
  assert.deepEqual(parsePicks(JSON.stringify({ no_picks: true }), new Set()), []);
});

test("buildDigestBlocks: header reflects pick count and includes PR url + codename per pick", () => {
  const candidates = [
    makeCandidate({ agentRunId: "a" }),
    makeCandidate({ agentRunId: "b", incidentCodename: "blue-eel" }),
  ];
  const { text, blocks } = buildDigestBlocks([
    { pick: { agentRunId: "a", rationale: "first reason" }, candidate: candidates[0]! },
    { pick: { agentRunId: "b", rationale: "second reason" }, candidate: candidates[1]! },
  ]);
  assert.ok(text.includes("purple-otter"));
  assert.ok(text.includes("blue-eel"));
  // Each pick contributes a section block plus the 2 header blocks.
  assert.equal(blocks.length, 4);
  const json = JSON.stringify(blocks);
  assert.ok(json.includes("Top 2 fixes to merge this week"));
  assert.ok(json.includes("first reason"));
  assert.ok(json.includes("second reason"));
});

test("buildDigestBlocks: singular subline when exactly one pick", () => {
  const candidate = makeCandidate();
  const { blocks } = buildDigestBlocks([
    { pick: { agentRunId: "a", rationale: "only one" }, candidate },
  ]);
  const json = JSON.stringify(blocks);
  assert.ok(json.includes("One pending bug-fix PR is ready"));
});

test("attachCandidatesToPicks: filters out picks whose id has no candidate, caps at TOP_N", () => {
  const cs = [
    makeCandidate({ agentRunId: "a" }),
    makeCandidate({ agentRunId: "b" }),
    makeCandidate({ agentRunId: "c" }),
    makeCandidate({ agentRunId: "d" }),
  ];
  const picks = [
    { agentRunId: "ghost", rationale: "?" },
    { agentRunId: "a", rationale: "x" },
    { agentRunId: "b", rationale: "y" },
    { agentRunId: "c", rationale: "z" },
    { agentRunId: "d", rationale: "w" },
  ];
  const out = attachCandidatesToPicks(picks, cs);
  assert.equal(out.length, TOP_N);
  assert.deepEqual(
    out.map((row) => row.pick.agentRunId),
    ["a", "b", "c"],
  );
});

test("trivialPicks truncates summary to 240 chars", () => {
  const long = "x".repeat(300);
  const out = trivialPicks([makeCandidate({ summary: long })]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.rationale.length, 240);
});

test("parsePicks truncates oversized rationale so Slack section text stays under its limit", () => {
  const oversized = "y".repeat(500);
  const raw = JSON.stringify({
    picks: [{ agentRunId: "a", rationale: oversized }],
  });
  const picks = parsePicks(raw, new Set(["a"]));
  assert.equal(picks.length, 1);
  assert.equal(picks[0]?.rationale.length, 240);
});
