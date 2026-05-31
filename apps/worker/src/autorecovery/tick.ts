import type { schema } from "@superlog/db";
import { type CandidateIncident, type ProposalToolInput, decideProposalOutcome } from "./domain.js";
import { type AutorecoveryPolicy, decideThrottle } from "./policy.js";
import type { AutorecoveryRepository, CandidateSelectionOptions } from "./repository.js";
import type { SlackPoster } from "./slack.js";

export type AutorecoveryLogger = {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
};

export type EvaluateIncidentDeps = {
  policy: AutorecoveryPolicy;
  repo: AutorecoveryRepository;
  slack: SlackPoster;
  logger: AutorecoveryLogger;
  runAgent(incident: CandidateIncident): Promise<ProposalToolInput | null>;
};

export type EvaluateIncidentResult =
  | {
      kind: "skipped";
      reason:
        | "no_project"
        | "no_live_signatures"
        | "still_happening"
        | "below_confidence"
        | "race_condition"
        | "no_proposal"
        | "agent_no_output";
    }
  | { kind: "proposed"; proposal: schema.IncidentResolutionProposal };

export async function evaluateIncident(
  incident: CandidateIncident,
  deps: EvaluateIncidentDeps,
): Promise<EvaluateIncidentResult> {
  const project = await deps.repo.findProject(incident.projectId);
  if (!project) return { kind: "skipped", reason: "no_project" };

  // Defense in depth against selectCandidates returning incidents whose live
  // issues have all been silenced/merged. The agent's `query_incident_activity`
  // would return zero in that case and the agent would happily call it
  // "recovered" — but the truth is we have no signal at all.
  if (incident.issueSignatures.length === 0) {
    deps.logger.info(
      { scope: "autorecovery", incident_id: incident.id },
      "no live issue signatures — skipping autorecovery",
    );
    return { kind: "skipped", reason: "no_live_signatures" };
  }

  const proposal = await deps.runAgent(incident);
  if (!proposal) return { kind: "skipped", reason: "agent_no_output" };

  const outcome = decideProposalOutcome(proposal, deps.policy.proposeMinConfidence);
  if (outcome.kind === "skip_not_resolved") {
    deps.logger.info(
      {
        scope: "autorecovery",
        incident_id: incident.id,
        confidence: proposal.confidence,
        reason_code: proposal.reason_code,
      },
      "agent verdict: still happening",
    );
    return { kind: "skipped", reason: "still_happening" };
  }
  if (outcome.kind === "skip_below_confidence") {
    deps.logger.info(
      {
        scope: "autorecovery",
        incident_id: incident.id,
        confidence: proposal.confidence,
        min: deps.policy.proposeMinConfidence,
      },
      "agent below confidence threshold",
    );
    return { kind: "skipped", reason: "below_confidence" };
  }

  // Re-check the open-proposal gate inside the insert — another tick or
  // a manual run shouldn't race us. The unique index doesn't cover this
  // window (slackMessageTs is null), so it's an explicit guard.
  const existing = await deps.repo.findOpenProposalForIncident(incident.id);
  if (existing) return { kind: "skipped", reason: "race_condition" };

  const proposalRow = await deps.repo.insertProposal({ incident, proposal });
  if (!proposalRow) return { kind: "skipped", reason: "no_proposal" };

  await postProposalIfPossible(incident, proposalRow, proposal, deps);
  return { kind: "proposed", proposal: proposalRow };
}

async function postProposalIfPossible(
  incident: CandidateIncident,
  proposalRow: schema.IncidentResolutionProposal,
  proposal: ProposalToolInput,
  deps: Pick<EvaluateIncidentDeps, "repo" | "slack" | "logger">,
): Promise<void> {
  if (!incident.slackChannelId || !incident.slackThreadTs) {
    deps.logger.info(
      { scope: "autorecovery", incident_id: incident.id },
      "no slack thread for proposal — recorded DB row only",
    );
    return;
  }
  if (!incident.slackInstallationId) {
    deps.logger.info(
      { scope: "autorecovery", incident_id: incident.id },
      "no slack installation for proposal — DB row only",
    );
    return;
  }
  const installation = await deps.repo.findSlackInstallation(incident.slackInstallationId);
  if (!installation) {
    deps.logger.info(
      { scope: "autorecovery", incident_id: incident.id },
      "no slack installation for proposal — DB row only",
    );
    return;
  }

  const res = await deps.slack.postProposal({
    installationId: installation.id,
    botAccessToken: installation.botAccessToken,
    channelId: incident.slackChannelId,
    threadTs: incident.slackThreadTs,
    proposalId: proposalRow.id,
    proposal,
  });
  if (res.ok) {
    await deps.repo.setProposalSlackMessageTs(proposalRow.id, res.ts);
  } else {
    deps.logger.warn(
      { scope: "autorecovery", incident_id: incident.id, error: res.error },
      "slack proposal post failed",
    );
  }
}

export type TickDeps = EvaluateIncidentDeps & {
  selectCandidates(
    now: Date,
    policy: AutorecoveryPolicy,
    opts?: CandidateSelectionOptions,
  ): Promise<CandidateIncident[]>;
  now(): Date;
};

// Throttled hourly pass. Selects candidates first, then stamps the cursor
// before iterating: stamping before the agent loop still prevents back-to-back
// retries of a long-running pass, but doing it *after* a successful
// `selectCandidates` means a failing selection query surfaces and retries on
// the next poll instead of silently advancing the cursor and hiding for an
// hour (which is exactly how the 42702 ambiguous-column bug went unnoticed).
export async function runAutorecoveryTick(deps: TickDeps): Promise<number> {
  const now = deps.now();
  const lastRun = await deps.repo.getLastRunAt();
  const throttle = decideThrottle(lastRun, now, deps.policy);
  if (throttle.kind === "skip") return 0;

  const candidates = await deps.selectCandidates(now, deps.policy);

  await deps.repo.setLastRunAt(now);

  if (candidates.length === 0) {
    deps.logger.info({ scope: "autorecovery" }, "no candidates");
    return 0;
  }
  deps.logger.info(
    { scope: "autorecovery", candidates: candidates.length },
    "autorecovery starting",
  );

  let proposalsWritten = 0;
  for (const candidate of candidates) {
    try {
      // Stamp the per-incident evaluation cursor up front, before the agent
      // runs, so this incident rotates to the back of the NULLS-FIRST queue
      // regardless of outcome — including a thrown agent call. Without this, an
      // incident the agent keeps declining (or that errors) would re-occupy the
      // front of the queue every tick and starve the rest of the backlog.
      // Kept inside the per-candidate try so a transient stamp-write failure
      // isolates to this incident (it'll just be re-picked next tick) instead
      // of aborting the whole pass.
      await deps.repo.markEvaluated(candidate.id, now);
      const result = await evaluateIncident(candidate, deps);
      if (result.kind === "proposed") proposalsWritten += 1;
    } catch (err) {
      deps.logger.warn(
        {
          scope: "autorecovery",
          incident_id: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "autorecovery candidate failed",
      );
    }
  }
  deps.logger.info(
    { scope: "autorecovery", proposalsWritten, candidates: candidates.length },
    "autorecovery done",
  );
  return proposalsWritten;
}

// Manual trigger used in tests and the end-to-end checkout — bypasses the
// hourly throttle so callers can drive an autorecovery pass on demand.
export async function runAutorecoveryNow(
  deps: TickDeps,
  opts?: { incidentIds?: string[] },
): Promise<{ candidates: number; proposalsWritten: number }> {
  const now = deps.now();
  const all = await deps.selectCandidates(now, deps.policy, {
    ignoreThrottles: !!opts?.incidentIds,
  });
  const candidates = opts?.incidentIds ? all.filter((c) => opts.incidentIds?.includes(c.id)) : all;
  if (candidates.length === 0) return { candidates: 0, proposalsWritten: 0 };

  let proposalsWritten = 0;
  for (const candidate of candidates) {
    try {
      const result = await evaluateIncident(candidate, deps);
      if (result.kind === "proposed") proposalsWritten += 1;
    } catch (err) {
      // Mirror the per-candidate isolation in runAutorecoveryTick — a single
      // failing incident must not abort a manual / forced pass over the rest.
      deps.logger.warn(
        {
          scope: "autorecovery",
          incident_id: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "autorecovery candidate failed",
      );
    }
  }
  return { candidates: candidates.length, proposalsWritten };
}
