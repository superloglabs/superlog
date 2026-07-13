import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentPrSweepDeps,
  type PollableAgentPr,
  hasHumanThumbsDown,
  runAgentPrLifecycleSweep,
} from "./agent-pr-sweep.js";

const NOW = new Date("2026-07-13T12:00:00Z");

function makePr(overrides: Partial<PollableAgentPr> = {}): PollableAgentPr {
  return {
    id: "pr-1",
    incidentId: "incident-1",
    agentRunId: "run-1",
    repoFullName: "acme/storefront",
    prNumber: 7,
    url: "https://github.com/acme/storefront/pull/7",
    createdAt: new Date("2026-07-10T12:00:00Z"),
    githubInstallationId: 1001,
    ...overrides,
  };
}

type CapturedEvent = { kind: string; prId: string; reason?: string };

function makeDeps(overrides: Partial<AgentPrSweepDeps> = {}): {
  deps: AgentPrSweepDeps;
  captured: CapturedEvent[];
} {
  const captured: CapturedEvent[] = [];
  const deps: AgentPrSweepDeps = {
    windowDays: 14,
    now: () => NOW,
    expireOpenPrs: async () => [],
    listOpenPrsForReactionPoll: async () => [],
    listReactions: async () => [],
    markNegativeReaction: async () => true,
    resolveOrg: async () => ({ id: "org-1", name: "Acme" }),
    capture: (input) => {
      captured.push({
        kind: input.kind,
        prId: input.pr.id,
        reason: input.kind === "rejected" ? input.reason : undefined,
      });
    },
    log: { info: () => {}, warn: () => {} },
    ...overrides,
  };
  return { deps, captured };
}

test("hasHumanThumbsDown: 👎 from a user counts, bots and other reactions don't", () => {
  assert.equal(hasHumanThumbsDown([{ content: "-1", user: { type: "User" } }]), true);
  assert.equal(hasHumanThumbsDown([{ content: "-1", user: { type: "Bot" } }]), false);
  assert.equal(hasHumanThumbsDown([{ content: "+1", user: { type: "User" } }]), false);
  assert.equal(hasHumanThumbsDown([{ content: "heart", user: { type: "User" } }]), false);
  assert.equal(hasHumanThumbsDown([{ content: "-1" }]), true); // missing user info: assume human
  assert.equal(hasHumanThumbsDown([]), false);
});

test("expired PRs emit one rejected(expired) event each", async () => {
  const prA = makePr({ id: "pr-a", createdAt: new Date("2026-06-01T00:00:00Z") });
  const prB = makePr({ id: "pr-b", createdAt: new Date("2026-06-10T00:00:00Z") });
  const { deps, captured } = makeDeps({ expireOpenPrs: async () => [prA, prB] });

  const result = await runAgentPrLifecycleSweep(deps);

  assert.equal(result.expired, 2);
  const rejected = captured.filter((c) => c.kind === "rejected");
  assert.deepEqual(
    rejected.map((c) => [c.prId, c.reason]),
    [
      ["pr-a", "expired"],
      ["pr-b", "expired"],
    ],
  );
});

test("expireOpenPrs is called with the window cutoff", async () => {
  let seenCutoff: Date | null = null;
  const { deps } = makeDeps({
    expireOpenPrs: async (cutoff) => {
      seenCutoff = cutoff;
      return [];
    },
  });

  await runAgentPrLifecycleSweep(deps);

  assert.ok(seenCutoff);
  const expected = new Date(NOW.getTime() - 14 * 86_400_000);
  assert.equal((seenCutoff as Date).getTime(), expected.getTime());
});

test("a 👎 on an open PR marks it and emits both the signal and the rejection", async () => {
  const pr = makePr();
  const marked: string[] = [];
  const { deps, captured } = makeDeps({
    listOpenPrsForReactionPoll: async () => [pr],
    listReactions: async () => [{ content: "-1", user: { type: "User" } }],
    markNegativeReaction: async (prId) => {
      marked.push(prId);
      return true;
    },
  });

  const result = await runAgentPrLifecycleSweep(deps);

  assert.equal(result.negativeReactions, 1);
  assert.deepEqual(marked, ["pr-1"]);
  assert.deepEqual(
    captured.map((c) => c.kind),
    ["negative_reaction", "rejected"],
  );
  assert.equal(captured[1]?.reason, "negative_reaction");
});

test("losing the conditional negative-reaction update emits nothing", async () => {
  const { deps, captured } = makeDeps({
    listOpenPrsForReactionPoll: async () => [makePr()],
    listReactions: async () => [{ content: "-1", user: { type: "User" } }],
    markNegativeReaction: async () => false,
  });

  const result = await runAgentPrLifecycleSweep(deps);

  assert.equal(result.negativeReactions, 0);
  assert.equal(captured.length, 0);
});

test("PRs without a 👎 are left alone", async () => {
  const { deps, captured } = makeDeps({
    listOpenPrsForReactionPoll: async () => [makePr()],
    listReactions: async () => [{ content: "+1", user: { type: "User" } }],
    markNegativeReaction: async () => {
      throw new Error("must not be called");
    },
  });

  const result = await runAgentPrLifecycleSweep(deps);

  assert.equal(result.negativeReactions, 0);
  assert.equal(captured.length, 0);
});

test("a reactions API failure on one PR doesn't stop the others", async () => {
  const prA = makePr({ id: "pr-a", prNumber: 1 });
  const prB = makePr({ id: "pr-b", prNumber: 2 });
  const { deps, captured } = makeDeps({
    listOpenPrsForReactionPoll: async () => [prA, prB],
    listReactions: async (_installationId, _repo, prNumber) => {
      if (prNumber === 1) throw new Error("rate limited");
      return [{ content: "-1", user: { type: "User" } }];
    },
  });

  const result = await runAgentPrLifecycleSweep(deps);

  assert.equal(result.negativeReactions, 1);
  assert.deepEqual(
    captured.map((c) => c.prId),
    ["pr-b", "pr-b"],
  );
});

test("an unresolvable org still emits events (org omitted, not dropped)", async () => {
  const { deps, captured } = makeDeps({
    expireOpenPrs: async () => [makePr({ createdAt: new Date("2026-06-01T00:00:00Z") })],
    resolveOrg: async () => null,
  });

  const result = await runAgentPrLifecycleSweep(deps);

  assert.equal(result.expired, 1);
  assert.equal(captured.length, 1);
});
