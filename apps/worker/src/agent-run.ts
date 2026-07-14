import type { AgentRunResult, DB, schema } from "@superlog/db";
import {
  ACTIVE_STATES,
  type AgentRunState,
  DORMANT_STATES,
  type LifecycleEventKind,
  TERMINAL_STATES,
  assertAgentRunSourceState,
  isActiveState,
} from "./agent-runs/domain.js";
import {
  type PauseForEventsRepositoryOutcome,
  createAgentRunRepository,
} from "./agent-runs/repository.js";

export {
  ACTIVE_STATES,
  type AgentRunState,
  DORMANT_STATES,
  type LifecycleEventKind,
  TERMINAL_STATES,
  isActiveState,
} from "./agent-runs/domain.js";
export type { PauseForEventsRepositoryOutcome as PauseForEventsOutcome } from "./agent-runs/repository.js";

export type AgentRunLifecycle = ReturnType<typeof createAgentRunLifecycle>;

export function createAgentRunLifecycle(db: DB) {
  const repository = createAgentRunRepository(db);

  return {
    /**
     * INSERT a new agentRun row in `queued` and emit
     * `agent_run_queued`. Returns the inserted row, or null if no row
     * was created (defensive — should not happen in practice).
     */
    async enqueue(opts: {
      incidentId: string;
      runtime: string;
    }): Promise<schema.AgentRun | null> {
      const row = await repository.insertQueuedRun(opts);
      if (!row) return null;
      await repository.insertEvent({
        agentRunId: row.id,
        kind: "agent_run_queued",
        summary: "Investigation queued.",
        dedupeKey: `queue:${row.id}`,
        processed: true,
      });
      return row;
    },

    /**
     * Transition `queued → repo_discovery`. No event — repo discovery is
     * an internal step; the human-visible event is `agent_run_started`
     * once a managed session is up.
     */
    async beginRepoDiscovery(opts: {
      id: string;
      currentState: AgentRunState | string;
    }): Promise<void> {
      assertAgentRunSourceState("beginRepoDiscovery", opts.currentState, [
        "queued",
        "repo_discovery",
      ]);
      await repository.updateRun(opts.id, { state: "repo_discovery" });
    },

    /**
     * Transition `repo_discovery → running`. Records the provider session
     * details and the start time. Emits `agent_run_started`.
     */
    async startRunning(opts: {
      id: string;
      currentState: AgentRunState | string;
      providerSessionId: string;
      providerSessionStatus?: string | null;
      repoCandidateCount: number;
    }): Promise<void> {
      assertAgentRunSourceState("startRunning", opts.currentState, ["repo_discovery"]);
      const now = new Date();
      await repository.updateRun(opts.id, {
        state: "running",
        providerSessionId: opts.providerSessionId,
        providerSessionStatus: opts.providerSessionStatus ?? "running",
        startedAt: now,
        updatedAt: now,
      });
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "agent_run_started",
        summary: `Investigation started across ${opts.repoCandidateCount} candidate repos.`,
        dedupeKey: `started:${opts.providerSessionId}`,
        processed: true,
      });
    },

    /**
     * Transition `running | repo_discovery → awaiting_human`. Records a
     * structured result with the question to relay. Emits `awaiting_human`.
     * `repo_discovery` is allowed so an agent run can pause for a
     * clarifying repo answer before a managed session is ever opened.
     */
    async pauseForHuman(opts: {
      id: string;
      currentState: AgentRunState | string;
      summary: string;
      question: string;
      result?: AgentRunResult;
    }): Promise<void> {
      assertAgentRunSourceState("pauseForHuman", opts.currentState, ["running", "repo_discovery"]);
      const result: AgentRunResult = opts.result
        ? {
            ...opts.result,
            state: "awaiting_human",
            summary: opts.summary,
            question: opts.question,
          }
        : {
            state: "awaiting_human",
            summary: opts.summary,
            question: opts.question,
          };
      await repository.updateRun(opts.id, {
        state: "awaiting_human",
        result,
      });
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "awaiting_human",
        summary: opts.summary,
        detail: {
          question: opts.question,
          ...(result.manualReconciliation
            ? { manualReconciliation: result.manualReconciliation }
            : {}),
        },
        dedupeKey: `awaiting_human:${opts.question}`,
        processed: true,
      });
    },

    /**
     * `running → awaiting_events`: the turn ended on a PR or external-cause
     * outcome. The durable session is kept; PR events and human/context
     * updates resume it through the same continuation path as awaiting_human.
     * Durable sessions from the previous contract may also park here after a
     * delivered PR without a terminal call.
     *
     * Two sync passes can both observe the session idle, so the state check
     * is folded into the UPDATE's WHERE: only the winner parks the run and
     * returns true; the loser gets false and must skip its side effects
     * (Slack messaging, metering).
     */
    async pauseForEvents(opts: {
      id: string;
      incidentId: string;
      currentState: AgentRunState | string;
      result: AgentRunResult;
    }): Promise<PauseForEventsRepositoryOutcome> {
      assertAgentRunSourceState("pauseForEvents", opts.currentState, ["running"]);
      const externalSource =
        opts.result.waitReason === "external_cause" ? opts.result.externalCause?.source : null;
      return repository.pauseForEventsIfIncidentOpen({
        id: opts.id,
        incidentId: opts.incidentId,
        result: opts.result,
        eventSummary: externalSource
          ? `Investigation is waiting on an external change from ${externalSource}.`
          : "Investigation is waiting on PR review/merge events.",
        now: new Date(),
      });
    },

    // Provider updates are intentionally outside the park transaction. Take a
    // fresh aggregate snapshot before publishing so a resolution that committed
    // immediately after the park suppresses stale waiting-state messages.
    async canPublishAwaitingEventsUpdate(opts: {
      id: string;
      incidentId: string;
    }): Promise<boolean> {
      return repository.canPublishAwaitingEventsUpdate(opts);
    },

    /**
     * `awaiting_human → queued`, used when no managed session exists yet
     * (the agentRun paused before startRunning ever fired). The next
     * tick reloads ctx and re-enters startQueuedAgentRun. No event —
     * the human-visible "resumed" event is only emitted once a real
     * managed session is resumed.
     */
    async requeueAfterHumanReply(opts: {
      id: string;
      currentState: AgentRunState | string;
    }): Promise<void> {
      assertAgentRunSourceState("requeueAfterHumanReply", opts.currentState, ["awaiting_human"]);
      await repository.updateRun(opts.id, { state: "queued" });
    },

    /**
     * `complete | failed → resuming`: a human message arrived after the run
     * finished. Reactivate so the next tick resumes the durable provider
     * session in place (continue the same investigation, keep the repo mounted
     * and the PR branch) rather than starting a new one. Clears the terminal
     * stamps; the human-visible `resumed` event is emitted by the resume
     * handler once the session actually accepts the message.
     */
    async reactivateForContinuation(opts: {
      id: string;
      currentState: AgentRunState | string;
    }): Promise<void> {
      assertAgentRunSourceState("reactivateForContinuation", opts.currentState, [
        "complete",
        "failed",
      ]);
      await repository.updateRun(opts.id, {
        state: "resuming",
        failureReason: null,
        completedAt: null,
      });
    },

    /**
     * `queued | repo_discovery → blocked_no_github`, when the project has
     * no GitHub install (or no accessible repos) so the agentRun
     * cannot make progress. Worker stops polling — the row is revived when
     * a GitHub install webhook fires for the project or the user restarts
     * the agentRun manually.
     */
    async blockForGithub(opts: {
      id: string;
      currentState: AgentRunState | string;
      summary: string;
      reason: "no_github_install" | "no_accessible_repos";
    }): Promise<void> {
      assertAgentRunSourceState("blockForGithub", opts.currentState, ["queued", "repo_discovery"]);
      await repository.updateRun(opts.id, { state: "blocked_no_github" });
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "blocked_no_github",
        summary: opts.summary,
        // Suffix with a timestamp so a re-block (after unblock → re-block by
        // the same reason) records a fresh audit event rather than getting
        // dropped by the (agentRunId, dedupeKey) unique constraint.
        dedupeKey: `blocked_no_github:${opts.reason}:${Date.now()}`,
        detail: { reason: opts.reason },
        processed: true,
      });
    },

    // Note: the `blocked_no_github → queued` transition is implemented in
    // bulk inside apps/api/src/github.ts (resumeBlockedAgentRunsForProjects).
    // A single install webhook can revive every blocked agentRun under
    // the affected project(s) in one round-trip, so there is no per-row
    // lifecycle method here — exposing one would create the illusion of a
    // shared governed path while the bulk update bypasses it.

    /**
     * `awaiting_human | awaiting_events | resuming → running`, after the
     * managed session accepted the inbound message. Resets startedAt: the
     * wall-clock budget is per active leg, so a run that legitimately waited
     * days on a PR review isn't reaped the moment it resumes. Emits `resumed`.
     *
     * resumeCount is the HUMAN-resume budget (it guards a runaway agent that
     * keeps re-pinging the human), so only awaiting_human resumes increment
     * it. Continuation resumes (`awaiting_events`, `resuming`) are driven by
     * external events — PR reviews, merges, replies to a finished run — and
     * must not eat the budget: several PR round-trips would otherwise fail
     * the next real human reply as human_resume_budget_exhausted.
     */
    async resumeRunning(opts: {
      id: string;
      currentState: AgentRunState | string;
      currentResumeCount: number;
      continuation?: boolean;
    }): Promise<boolean> {
      assertAgentRunSourceState("resumeRunning", opts.currentState, [
        "awaiting_human",
        "awaiting_events",
        "resuming",
      ]);
      const nextResumeCount = opts.continuation
        ? opts.currentResumeCount
        : opts.currentResumeCount + 1;
      const resumed = await repository.updateRunIfState(
        opts.id,
        opts.currentState as AgentRunState,
        {
          state: "running",
          resumeCount: nextResumeCount,
          startedAt: new Date(),
        },
      );
      if (!resumed) return false;
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "resumed",
        summary: "Investigation resumed with human input.",
        // Continuations don't advance the counter, so the count alone can't
        // dedupe them — suffix a timestamp so each continuation resume still
        // records a fresh audit event.
        dedupeKey: opts.continuation
          ? `resumed:${nextResumeCount}:${Date.now()}`
          : `resumed:${nextResumeCount}`,
        processed: true,
      });
      return true;
    },

    /**
     * `pr_retry_queued → running`: a human asked to re-deliver a run whose
     * PR open had failed. Re-enters `running` so the existing PR-delivery path
     * (apply patch → push → open) can run again and complete or re-fail
     * normally. Clears the failure stamp from the previous attempt; the patch
     * itself is carried on the run's result.
     */
    async startPrRetry(opts: {
      id: string;
      currentState: AgentRunState | string;
    }): Promise<void> {
      assertAgentRunSourceState("startPrRetry", opts.currentState, ["pr_retry_queued"]);
      const now = new Date();
      await repository.updateRun(opts.id, {
        state: "running",
        failureReason: null,
        completedAt: null,
        updatedAt: now,
      });
    },

    /**
     * `running → complete` after a PR was opened by the orchestrator.
     * Caller has already pushed the branch and opened the PR; this method
     * only records the terminal state + emits `pr_opened`.
     */
    async completeWithPullRequest(opts: {
      id: string;
      currentState: AgentRunState | string;
      result: AgentRunResult;
      selectedRepoFullName: string;
      selectedBaseBranch: string;
      prUrl: string;
    }): Promise<boolean> {
      assertAgentRunSourceState("completeWithPullRequest", opts.currentState, ["running"]);
      return repository.completeRunWithPullRequestIfRunning({
        id: opts.id,
        result: opts.result,
        selectedRepoFullName: opts.selectedRepoFullName,
        selectedBaseBranch: opts.selectedBaseBranch,
        prUrl: opts.prUrl,
        now: new Date(),
      });
    },

    /**
     * `running → complete` for the no-PR path (noise classification, agent
     * already-resolved, or PR policy = never). Emits
     * `agent_run_completed` so the audit trail is uniform with the
     * other completion paths.
     */
    async completeWithoutPullRequest(opts: {
      id: string;
      currentState: AgentRunState | string;
      result: AgentRunResult;
    }): Promise<boolean> {
      assertAgentRunSourceState("completeWithoutPullRequest", opts.currentState, ["running"]);
      return repository.completeRunIfRunning({
        id: opts.id,
        result: opts.result,
        now: new Date(),
      });
    },

    /**
     * `running → complete` via merge into another open incident. Performs
     * the full merge transactionally: marks the source incident merged,
     * reassigns its issues, increments target counters, then completes
     * the agentRun and emits `merged_into_incident`.
     */
    async completeViaMerge(opts: {
      id: string;
      currentState: AgentRunState | string;
      result: AgentRunResult;
      sourceIncident: schema.Incident;
      targetIncident: schema.Incident;
      evidence: string;
    }): Promise<void> {
      assertAgentRunSourceState("completeViaMerge", opts.currentState, ["running"]);
      const now = new Date();
      await repository.completeRunAndMergeIncidents({
        id: opts.id,
        result: opts.result,
        completedAt: now,
        sourceIncident: opts.sourceIncident,
        targetIncident: opts.targetIncident,
      });

      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "merged_into_incident",
        summary: `Merged into ${opts.targetIncident.codename || opts.targetIncident.title}`,
        detail: {
          targetIncidentId: opts.targetIncident.id,
          targetCodename: opts.targetIncident.codename,
          evidence: opts.evidence,
        },
        dedupeKey: `merge:${opts.sourceIncident.id}:${opts.targetIncident.id}`,
        processed: true,
      });
    },

    /**
     * Any active state → `failed`. Records the failure reason, completes
     * the row, and emits `terminal_failure`. The `existingResult` field is
     * preserved (PR snapshot, Linear ticket) when the agent had already
     * produced a partial result.
     */
    async fail(opts: {
      id: string;
      currentState: AgentRunState | string;
      reason: schema.AgentRunFailureReason;
      summary: string;
      category: "agent" | "deliverable" | "infrastructure" | string;
      existingResult?: AgentRunResult | null;
    }): Promise<void> {
      assertAgentRunSourceState("fail", opts.currentState, [
        "queued",
        "repo_discovery",
        "running",
        "awaiting_human",
        "awaiting_events",
        "resuming",
        "pr_retry_queued",
        "blocked_no_github",
      ]);
      const now = new Date();
      const existing = opts.existingResult ?? null;
      const result: AgentRunResult = {
        state: "failed",
        summary: opts.summary,
        failureReason: opts.reason,
        pr: existing?.pr ?? null,
        // A failing parked run may already have delivered PRs, or a durable
        // legacy run may have classified Issues action by action. Preserve
        // those records so the Incident still shows them.
        prs: existing?.prs ?? null,
        issueClassifications: existing?.issueClassifications ?? null,
        linearTicket: existing?.linearTicket ?? null,
        rootCauseConfidence: existing?.rootCauseConfidence ?? null,
      };
      await repository.updateRun(opts.id, {
        state: "failed",
        failureReason: opts.reason,
        completedAt: now,
        updatedAt: now,
        result,
      });
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "terminal_failure",
        summary: opts.summary,
        detail: { reason: opts.reason, category: opts.category },
        dedupeKey: `terminal:failed:${opts.reason}:${opts.summary}`,
        processed: true,
      });
    },

    // ─── Non-transition events ───────────────────────────────────────────

    /** Emit `repo_selected` while the agent run is running. */
    async appendRepoSelectedEvent(opts: {
      agentRunId: string;
      selectedRepoFullName: string;
    }): Promise<void> {
      await repository.insertEvent({
        agentRunId: opts.agentRunId,
        kind: "repo_selected",
        summary: `Selected repo ${opts.selectedRepoFullName}.`,
        dedupeKey: `repo:${opts.selectedRepoFullName}`,
        processed: true,
      });
    },

    /**
     * Emit `incident_context_changed` (unprocessed) so a later running
     * tick can fold the new context into the agent steer message.
     */
    async appendContextChangeEvent(opts: {
      agentRunId: string;
      summary: string;
      dedupeKey: string;
    }): Promise<void> {
      await repository.insertEvent({
        agentRunId: opts.agentRunId,
        kind: "incident_context_changed",
        summary: opts.summary,
        dedupeKey: opts.dedupeKey,
        // intentionally not processed: tickAgentRuns consumes these
      });
    },

    /**
     * Pass-through helper for events emitted by the agent runtime. The
     * `kind` is intentionally not constrained to LifecycleEventKind — the
     * runtime is the source of truth for these.
     */
    async appendAgentEvent(opts: {
      agentRunId: string;
      kind: string;
      summary?: string | null;
      providerEventId?: string | null;
      detail?: Record<string, unknown> | null;
    }): Promise<void> {
      await repository.appendAgentEvent(opts);
    },
  };
}
