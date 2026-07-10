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
import { createAgentRunRepository } from "./agent-runs/repository.js";

export {
  ACTIVE_STATES,
  type AgentRunState,
  DORMANT_STATES,
  type LifecycleEventKind,
  TERMINAL_STATES,
  isActiveState,
} from "./agent-runs/domain.js";

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
    }): Promise<void> {
      assertAgentRunSourceState("pauseForHuman", opts.currentState, ["running", "repo_discovery"]);
      const result: AgentRunResult = {
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
        detail: { question: opts.question },
        dedupeKey: `awaiting_human:${opts.question}`,
        processed: true,
      });
    },

    /**
     * `running → awaiting_events`: the turn ended without a terminal outcome
     * call while the run has PRs out for review. The durable session is kept;
     * PR events (comment, merge, close) and human messages resume it via the
     * same continuation path as awaiting_human. Stores the partial result
     * (findings + actions so far) and emits `awaiting_events`.
     */
    async pauseForEvents(opts: {
      id: string;
      currentState: AgentRunState | string;
      result: AgentRunResult;
    }): Promise<void> {
      assertAgentRunSourceState("pauseForEvents", opts.currentState, ["running"]);
      await repository.updateRun(opts.id, {
        state: "awaiting_events",
        result: opts.result,
      });
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "awaiting_events",
        summary: "Investigation is waiting on PR review/merge events.",
        dedupeKey: `awaiting_events:${opts.id}:${Date.now()}`,
        processed: true,
      });
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
     * managed session accepted the inbound message. Increments resumeCount and
     * resets startedAt: the wall-clock budget is per active leg, so a run that
     * legitimately waited days on a PR review isn't reaped the moment it
     * resumes. Emits `resumed`.
     */
    async resumeRunning(opts: {
      id: string;
      currentState: AgentRunState | string;
      currentResumeCount: number;
    }): Promise<void> {
      assertAgentRunSourceState("resumeRunning", opts.currentState, [
        "awaiting_human",
        "awaiting_events",
        "resuming",
      ]);
      const nextResumeCount = opts.currentResumeCount + 1;
      await repository.updateRun(opts.id, {
        state: "running",
        resumeCount: nextResumeCount,
        startedAt: new Date(),
      });
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "resumed",
        summary: "Investigation resumed with human input.",
        dedupeKey: `resumed:${nextResumeCount}`,
        processed: true,
      });
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
    }): Promise<void> {
      assertAgentRunSourceState("completeWithPullRequest", opts.currentState, ["running"]);
      const now = new Date();
      await repository.updateRun(opts.id, {
        state: "complete",
        selectedRepoFullName: opts.selectedRepoFullName,
        selectedBaseBranch: opts.selectedBaseBranch,
        completedAt: now,
        updatedAt: now,
        result: opts.result,
      });
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "pr_opened",
        summary: `Opened PR: ${opts.prUrl}`,
        detail: { url: opts.prUrl },
        dedupeKey: `pr:${opts.prUrl}`,
        processed: true,
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
    }): Promise<void> {
      assertAgentRunSourceState("completeWithoutPullRequest", opts.currentState, ["running"]);
      const now = new Date();
      await repository.updateRun(opts.id, {
        state: "complete",
        result: opts.result,
        completedAt: now,
        updatedAt: now,
      });
      await repository.insertEvent({
        agentRunId: opts.id,
        kind: "agent_run_completed",
        summary: opts.result.summary,
        dedupeKey: `completed:${opts.id}`,
        processed: true,
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
