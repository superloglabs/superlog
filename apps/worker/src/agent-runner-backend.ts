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

export type AgentRunnerBackend = {
  name: string;
  maxRepoResources: number;
  start(input: AgentRunnerStartInput): Promise<{ sessionId: string }>;
  collect(sessionId: string): Promise<AgentRunnerSnapshot>;
  resume(sessionId: string, message: string): Promise<void>;
  steer(sessionId: string, message: string): Promise<void>;
  dispatchIntegrationToolCalls(input: {
    sessionId: string;
    orgId: string;
    incidentId: string;
  }): Promise<number>;
};
