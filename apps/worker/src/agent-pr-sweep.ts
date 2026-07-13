// Agent-PR lifecycle sweep: the two rejection signals GitHub doesn't push to
// us. Merge and close arrive over the webhook (apps/api/src/github.ts); a 👎
// reaction has no webhook event at all, and "nobody ever touched it" is by
// definition not an event — so both are detected here by polling, on the
// schedule in jobs/agent-pr-lifecycle.ts.
//
// - Expiry: an open PR older than the window counts as rejected (reason
//   `expired`). A later merge supersedes it — the acceptance metric resolves
//   accepted-over-rejected per pr_id — so expiring is safe even when a PR
//   eventually lands.
// - Negative reaction: a human 👎 on the PR body counts as rejected (reason
//   `negative_reaction`) and also emits its own standalone signal event.
//
// Exactly-once: both signals are recorded in Postgres first via conditional
// IS NULL-guarded updates (deps.expireOpenPrs / deps.markNegativeReaction);
// events are only emitted for rows the update actually won, so concurrent or
// re-run sweeps can't double-emit. Pure orchestration — all IO is injected —
// so the decision logic is unit-testable without a database or GitHub.

import {
  type AgentPrLifecycleEventInput,
  type AgentPrRejectionReason,
  daysBetween,
} from "@superlog/db";

export const AGENT_PR_EXPIRY_WINDOW_DAYS_DEFAULT = 14;

export type SweptAgentPr = {
  id: string;
  incidentId: string;
  agentRunId: string;
  repoFullName: string;
  prNumber: number;
  url: string;
  createdAt: Date;
};

export type PollableAgentPr = SweptAgentPr & {
  /** GitHub's numeric installation id (github_installations.installation_id). */
  githubInstallationId: number;
};

export type GithubReaction = {
  content: string;
  user?: { type?: string } | null;
};

export type AgentPrSweepDeps = {
  windowDays: number;
  now: () => Date;
  /**
   * Stamp expired_at=now on open PRs created before `cutoff` that have neither
   * signal yet, returning only the rows this call actually flipped.
   */
  expireOpenPrs(cutoff: Date, now: Date): Promise<SweptAgentPr[]>;
  /** Open PRs inside the window with no negative-reaction signal yet. */
  listOpenPrsForReactionPoll(cutoff: Date): Promise<PollableAgentPr[]>;
  listReactions(
    githubInstallationId: number,
    repoFullName: string,
    prNumber: number,
  ): Promise<GithubReaction[]>;
  /**
   * Conditionally stamp negative_reaction_at; true iff this call won. The
   * implementation must also require the row to still be open and unexpired,
   * so a poll that raced a concurrent merge/close webhook loses.
   */
  markNegativeReaction(prId: string, now: Date): Promise<boolean>;
  resolveOrg(incidentId: string): Promise<{ id: string; name: string } | null>;
  capture(input: AgentPrLifecycleEventInput): void;
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
};

/**
 * True when any reaction is a 👎 from something that isn't a bot. A reaction
 * with no user info still counts — better a false rejection a later merge
 * overrides than a silently ignored human signal.
 */
export function hasHumanThumbsDown(reactions: GithubReaction[]): boolean {
  return reactions.some((r) => r.content === "-1" && r.user?.type !== "Bot");
}

async function emitRejection(
  deps: AgentPrSweepDeps,
  pr: SweptAgentPr,
  reason: AgentPrRejectionReason,
  now: Date,
  opts: { withSignalEvent?: boolean } = {},
): Promise<void> {
  const org = await deps.resolveOrg(pr.incidentId);
  if (opts.withSignalEvent) {
    deps.capture({ kind: "negative_reaction", pr, org });
  }
  deps.capture({
    kind: "rejected",
    pr,
    org,
    reason,
    daysToOutcome: daysBetween(pr.createdAt, now),
  });
}

export async function runAgentPrLifecycleSweep(
  deps: AgentPrSweepDeps,
): Promise<{ expired: number; negativeReactions: number }> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - deps.windowDays * 86_400_000);

  const expired = await deps.expireOpenPrs(cutoff, now);
  for (const pr of expired) {
    await emitRejection(deps, pr, "expired", now);
  }

  let negativeReactions = 0;
  const toPoll = await deps.listOpenPrsForReactionPoll(cutoff);
  for (const pr of toPoll) {
    let reactions: GithubReaction[];
    try {
      reactions = await deps.listReactions(pr.githubInstallationId, pr.repoFullName, pr.prNumber);
    } catch (err) {
      deps.log.warn(
        { err: err instanceof Error ? err.message : String(err), pr_id: pr.id, url: pr.url },
        "agent-pr sweep: reactions poll failed; skipping PR",
      );
      continue;
    }
    if (!hasHumanThumbsDown(reactions)) continue;
    if (!(await deps.markNegativeReaction(pr.id, now))) continue;
    negativeReactions += 1;
    await emitRejection(deps, pr, "negative_reaction", now, { withSignalEvent: true });
  }

  if (expired.length > 0 || negativeReactions > 0) {
    deps.log.info(
      { expired: expired.length, negative_reactions: negativeReactions, polled: toPoll.length },
      "agent-pr sweep: recorded rejection signals",
    );
  }
  return { expired: expired.length, negativeReactions };
}
