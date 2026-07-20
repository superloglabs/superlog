import type {
  AgentMemoryKind,
  AgentRunFollowUpInteraction,
  AgentRunFollowUpPullRequest,
  AgentRunResult,
  AgentRunTrigger,
  PrPolicy,
} from "@superlog/db";
import type { AgentRunFindings, ExecutedAction } from "./agent-outcome-tools.js";

export type AgentRunnerRepoCandidate = {
  fullName: string;
  cloneUrl: string;
  installationToken: string;
  score: number;
  // Agent-instruction files (CLAUDE.md, AGENTS.md, .cursorrules,
  // .cursor/rules/*, .github/copilot-instructions.md) detected on the repo's
  // default branch at start time. Best-effort — empty when probing failed or
  // was skipped for a low-scored candidate. Runners surface these so the
  // agent reads them after cloning and follows the repo's conventions.
  instructionFiles: string[];
};

// The trigger context for an alert-episode issue: the alert's configuration
// (what is measured and the breach condition) plus the episode — the specific
// breach period, with its window and observed values. Timestamps are ISO
// strings.
export type AgentRunnerAlertEpisode = {
  alert: {
    id: string;
    name: string;
    source: string;
    metricName: string | null;
    filter: Record<string, unknown>;
    groupBy: string | null;
    groupMode: string;
    aggregation: string;
    comparator: "gt" | "lt";
    threshold: number;
    windowMinutes: number;
    evaluationIntervalSeconds: number;
  };
  episode: {
    id: string;
    groupKey: string;
    state: "firing" | "resolved";
    startedAt: string;
    endedAt: string | null;
    openObservedValue: number;
    peakObservedValue: number;
    lastObservedValue: number;
    lastFiringAt: string;
  };
};

export type AgentRunnerIssueSummary = {
  id: string;
  title: string;
  exceptionType: string;
  message: string | null;
  topFrame: string | null;
  normalizedFrames: string[];
  stacktrace: string | null;
  sessionId: string | null;
  lastSample: unknown;
  traceContext: string | null;
  // Set for alert-episode issues (kind='alert'); null for errors.
  alertEpisode: AgentRunnerAlertEpisode | null;
};

export type AgentRunnerMemory = {
  id: string;
  kind: AgentMemoryKind;
  title: string;
  body: string;
};

// A closed incident this run's incident descends from (recurrence /
// escalation chain via incidents.previous_incident_id, newest first). Gives
// the new investigation the prior findings without re-deriving them.
export type AgentRunnerPredecessorIncident = {
  incidentId: string;
  title: string;
  codename: string;
  resolvedAt: string | null;
  resolvedReasonCode: string | null;
  resolvedReasonText: string | null;
  agentSummary: string | null;
  rootCauseText: string | null;
  handoffNotes: string | null;
  prUrls: string[];
};

// Context for a follow-up run revived by a human interaction after a prior
// investigation finished. The prior session is gone; this block plus the PR
// branch and project memories is everything the new session inherits.
export type AgentRunnerFollowUp = {
  trigger: Exclude<AgentRunTrigger, "incident">;
  interactions: AgentRunFollowUpInteraction[];
  // All currently-open PRs on the Incident, including PRs delivered by an
  // earlier run in the same investigation.
  pullRequests: AgentRunFollowUpPullRequest[];
  priorRun: {
    state: "complete" | "failed";
    summary: string;
    rootCause: string | null;
    handoffNotes: string | null;
    validationSummary: string | null;
    repoFullName: string | null;
    prBranch: string | null;
    prUrl: string | null;
  } | null;
  // Condensed incident timeline ("kind: summary" lines, oldest first).
  timeline: string[];
};

export type AgentRunnerStartInput = {
  incidentId: string;
  projectId: string;
  orgId: string;
  title: string;
  service: string | null;
  issueSummaries: AgentRunnerIssueSummary[];
  repoCandidates: AgentRunnerRepoCandidate[];
  mcpResource: string | null;
  prPolicy: PrPolicy;
  approvalPromptsEnabled: boolean;
  // True only when at least one currently registered integration operation
  // is implemented as an approval prompt for this run.
  approvalPromptToolsAvailable: boolean;
  prBaseBranch: string | null;
  githubConnected: boolean;
  telemetryInvestigationHint: string;
  customInstructions: string;
  // The user's free-text brief for a manually-started investigation. Null for
  // ordinary auto incident runs; injected into the agent's initial prompt.
  customPrompt: string | null;
  // Durable cross-run facts (terminology, infra, feedback lessons) saved by
  // earlier runs or by users. Injected into the initial prompt in full.
  memories: AgentRunnerMemory[];
  // Null for ordinary incident-triggered investigations.
  followUp: AgentRunnerFollowUp | null;
  // Closed incidents this one descends from (recurrence/escalation chain),
  // newest first, capped. Empty for first-time incidents.
  predecessors: AgentRunnerPredecessorIncident[];
};

// A pending outcome-action tool call handed to the worker's executor by the
// backend's dispatch loop. `hasFindings` reflects whether a valid
// report_findings call has been seen earlier in the current turn — the
// executor's validation needs it for the findings-first gate.
export type OutcomeActionCall = {
  toolUseId: string;
  name: string;
  input: unknown;
  hasFindings: boolean;
  findings: import("./agent-outcome-tools.js").AgentRunFindings | null;
};

export type OutcomeActionExecution =
  // handled: the executor ran (or rejected) the action; ack `payload` back
  // into the session with is_error = !ok.
  | {
      handled: true;
      deferAck?: false;
      ok: boolean;
      payload: Record<string, unknown>;
    }
  // The action may have mutated external state, but its durable receipt could
  // not be confirmed. Leave the call pending so an exact replay can recover.
  | { handled: true; deferAck: true }
  // Not an outcome action — the dispatch loop tries its other handlers.
  | { handled: false };

export type AgentRunnerSnapshot = {
  sessionId: string;
  status: "running" | "idle" | "terminated" | "rescheduling";
  activeSeconds: number;
  events: Array<{
    id: string;
    type: string;
    processedAt: string | null;
    summary: string | null;
    detail: Record<string, unknown> | null;
  }>;
  result: AgentRunResult | null;
  // Compatibility state for durable turns created before propose_pr became
  // terminal: merged findings plus their retained actions. sync.ts uses it to
  // assemble the parked result after one of those turns delivers a PR.
  // Optional so runners without the outcome toolset are unaffected.
  pendingOutcome?: {
    findings: AgentRunFindings | null;
    actions: ExecutedAction[];
  };
  // Present while a batched propose_pr has delivered at least one repository
  // but still owes exact retries for the remaining repositories. Optional so
  // runners without the outcome toolset remain source-compatible.
  partialPullRequestDelivery?: {
    delivered: Array<{
      repoFullName: string;
      branchName: string;
      url: string | null;
    }>;
    pendingRepoFullNames: string[];
  } | null;
  // Present for every incomplete or safety-blocked PR delivery. Optional so
  // runners without the outcome toolset remain source-compatible.
  blockingPullRequestDelivery?: {
    kind: "retry_required" | "incident_not_open" | "manual_reconciliation_required";
    delivered: Array<{
      repoFullName: string;
      branchName: string;
      url: string | null;
    }>;
  } | null;
  // Custom tools the runtime had no handler for. The collector ack's them
  // with an error result so the session can leave requires_action; sync.ts
  // then fails the run with `unknown_custom_tool` so we can audit them later.
  unknownCustomTools: Array<{ toolUseId: string; name: string }>;
  // How many custom_tool_result acks this collect pass sent. When > 0 the
  // `status` above is stale — it was captured before the acks went out and
  // the model is about to resume with the tool results. sync.ts uses this to
  // defer steering for a tick (see shouldDeferSteering). Optional so runners
  // without a collect-time ack step are unaffected.
  sentToolAckCount?: number;
  latestMessage: string | null;
  modelUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    model: string;
  };
};

// A Slack Q&A chat session (see packages/db agent_chats): answers questions
// about the project's code and telemetry, delivers replies through a custom
// tool the worker dispatches, and never produces an investigation outcome.
export type AgentChatStartInput = {
  chatId: string;
  projectId: string;
  orgId: string;
  projectName: string;
  // The first question (mention already stripped).
  question: string;
  // Slack display handle of the asker, e.g. "<@U123>", when known.
  requester: string | null;
  repoCandidates: AgentRunnerRepoCandidate[];
  mcpResource: string | null;
  customInstructions: string;
  memories: AgentRunnerMemory[];
};

export type AgentChatDispatchResult = {
  // Tool calls served during this dispatch pass.
  handled: number;
  // Reply-tool calls observed since the turn's last user message (served now
  // or on an earlier pass). Zero at idle means the agent never delivered an
  // answer this turn and the caller should fall back to its last message.
  repliesThisTurn: number;
};

// Why delivering a message into a durable session failed.
//   - "wedged_turn": the session is alive but its current turn is blocked on
//     unanswered tool events, so the runtime rejects new messages. An
//     `interrupt` closes the turn and makes the session deliverable again.
//   - "session_gone": the runtime no longer has the session (expired or
//     deleted) — only this kind justifies discarding the session's context.
//   - "unknown": neither state is provable from the error.
export type SessionDeliveryErrorKind = "wedged_turn" | "session_gone" | "unknown";

export type AgentRunnerBackend = {
  name: string;
  maxRepoResources: number;
  start(input: AgentRunnerStartInput): Promise<{ sessionId: string }>;
  // Release a session that is no longer reachable from an open Incident.
  // Implementations must be idempotent: an already-absent provider session is
  // success so a delete followed by a failed DB acknowledgement can retry.
  terminate(sessionId: string): Promise<void>;
  // Chat sessions reuse collect(); creation and messaging differ (chat prompt
  // + reply tool instead of the investigation outcome toolset — resume/steer
  // wrap messages in investigation framing a chat must not inherit).
  startChat(input: AgentChatStartInput): Promise<{ sessionId: string }>;
  // Deliver a follow-up human message into a chat session. One method covers
  // both the idle-resume and mid-turn-steer cases: they are the same provider
  // event, only the investigation flow needs to distinguish them.
  sendChatMessage(sessionId: string, message: string): Promise<void>;
  collect(sessionId: string): Promise<AgentRunnerSnapshot>;
  resume(sessionId: string, message: string): Promise<void>;
  steer(sessionId: string, message: string): Promise<void>;
  // Optional: classify a resume/steer delivery failure so the caller can
  // repair a wedged turn in place instead of discarding a live session.
  classifyDeliveryError?(err: unknown): SessionDeliveryErrorKind;
  // Optional: interrupt the session's open turn so a queued message becomes
  // deliverable. Only meaningful for runtimes that report "wedged_turn".
  interrupt?(sessionId: string): Promise<void>;
  dispatchIntegrationToolCalls(input: {
    sessionId: string;
    orgId: string;
    projectId: string;
    incidentId: string;
    // Delivers propose_pr and preflights resolve_incident before their terminal
    // success acks. When absent (e.g. a caller without run context), the
    // backend error-acks those calls so the session never deadlocks.
    executeOutcomeAction?: (call: OutcomeActionCall) => Promise<OutcomeActionExecution>;
  }): Promise<number>;
  // Serve a chat session's pending tool calls (memory tools + the reply
  // tool). `onReply` posts the reply text to the chat's channel — the worker
  // owns Slack delivery; the backend only surfaces the calls and acks them
  // (error-acks when onReply throws, so the agent knows delivery failed).
  // `replyId` is stable across dispatch retries of the same tool call (the
  // provider tool-use id): if a reply posted but its ack failed, the retry
  // passes the same id and the worker's dedupe skips the re-post.
  dispatchChatToolCalls(input: {
    sessionId: string;
    orgId: string;
    projectId: string;
    chatId: string;
    onReply(text: string, replyId: string): Promise<void>;
  }): Promise<AgentChatDispatchResult>;
};
