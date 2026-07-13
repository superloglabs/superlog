// Agent-PR lifecycle analytics events, the PostHog half of the PR acceptance
// metric. One shared emitter so the API (webhook merge/close), the worker (PR
// open, lifecycle sweep), and backfills all produce identically-shaped events.
//
// Model: append-only events keyed by the agent_pull_requests row id. A PR's
// outcome can flip after the fact (counted expired, merged later), so nothing
// is ever corrected — dashboards resolve precedence per pr_id instead
// (accepted-ever wins over rejected, rejected over pending).
//
// Delivery rides on captureServerEvent: env-gated, best-effort, never throws.
// Callers must only invoke this after winning the corresponding durable
// Postgres write (conditional UPDATE / insert .returning) so each transition
// emits at most once.

import { captureServerEvent } from "./analytics.js";

export type AgentPrRejectionReason = "closed_unmerged" | "negative_reaction" | "expired";

export type AgentPrAnalyticsPr = {
  id: string;
  incidentId: string;
  agentRunId: string;
  repoFullName: string;
  prNumber: number;
  url: string;
};

export type AgentPrAnalyticsOrg = { id: string; name: string } | null;

export type AgentPrLifecycleEventInput =
  | { kind: "opened"; pr: AgentPrAnalyticsPr; org: AgentPrAnalyticsOrg }
  | {
      kind: "accepted";
      pr: AgentPrAnalyticsPr;
      org: AgentPrAnalyticsOrg;
      daysToOutcome: number | null;
      mergedByLogin?: string | null;
    }
  | {
      kind: "rejected";
      pr: AgentPrAnalyticsPr;
      org: AgentPrAnalyticsOrg;
      reason: AgentPrRejectionReason;
      daysToOutcome: number | null;
    }
  | { kind: "negative_reaction"; pr: AgentPrAnalyticsPr; org: AgentPrAnalyticsOrg };

const EVENT_NAMES = {
  opened: "agent_pr_opened",
  accepted: "agent_pr_accepted",
  rejected: "agent_pr_rejected",
  negative_reaction: "agent_pr_negative_reaction",
} as const;

/** Fractional days between two instants; null unless both are known. */
export function daysBetween(from: Date | null | undefined, to: Date | null | undefined) {
  if (!from || !to) return null;
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/**
 * Emit one agent-PR lifecycle event. `org` is nullable so a PR whose incident
 * can no longer be resolved to an org still counts — the metric dedupes on
 * pr_id, not org.
 */
export function captureAgentPrLifecycleEvent(input: AgentPrLifecycleEventInput): void {
  const properties: Record<string, unknown> = {
    pr_id: input.pr.id,
    incident_id: input.pr.incidentId,
    agent_run_id: input.pr.agentRunId,
    repo: input.pr.repoFullName,
    pr_number: input.pr.prNumber,
    url: input.pr.url,
    // PRs are not people: keep these events personless so each PR doesn't
    // mint a person profile in PostHog.
    $process_person_profile: false,
  };
  if (input.org) {
    properties.org_id = input.org.id;
    properties.org_name = input.org.name;
  }
  if (input.kind === "accepted") {
    properties.days_to_accept = input.daysToOutcome;
    properties.merged_by = input.mergedByLogin ?? null;
  } else if (input.kind === "rejected") {
    properties.reason = input.reason;
    properties.days_to_reject = input.daysToOutcome;
  }
  captureServerEvent({
    distinctId: input.pr.id,
    event: EVENT_NAMES[input.kind],
    properties,
  });
}
