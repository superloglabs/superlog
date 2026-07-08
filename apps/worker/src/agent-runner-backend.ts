import type {
  AgentMemoryKind,
  AgentRunFollowUpInteraction,
  AgentRunResult,
  AgentRunTrigger,
  PrPolicy,
} from "@superlog/db";

export type AgentRunnerRepoCandidate = {
  fullName: string;
  cloneUrl: string;
  installationToken: string;
  score: number;
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
  // Custom tools the runtime had no handler for. The collector ack's them
  // with an error result so the session can leave requires_action; sync.ts
  // then fails the run with `unknown_custom_tool` so we can audit them later.
  unknownCustomTools: Array<{ toolUseId: string; name: string }>;
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

export type AgentRunnerBackend = {
  name: string;
  maxRepoResources: number;
  start(input: AgentRunnerStartInput): Promise<{ sessionId: string }>;
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
  dispatchIntegrationToolCalls(input: {
    sessionId: string;
    orgId: string;
    incidentId: string;
  }): Promise<number>;
  // Serve a chat session's pending tool calls (memory tools + the reply
  // tool). `onReply` posts the reply text to the chat's channel — the worker
  // owns Slack delivery; the backend only surfaces the calls and acks them
  // (error-acks when onReply throws, so the agent knows delivery failed).
  dispatchChatToolCalls(input: {
    sessionId: string;
    orgId: string;
    projectId: string;
    chatId: string;
    onReply(text: string): Promise<void>;
  }): Promise<AgentChatDispatchResult>;
};
