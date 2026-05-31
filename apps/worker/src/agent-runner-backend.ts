import type {
  AgentRunResult,
  LinearTicketInstruction,
  LinearTicketPolicy,
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
  lastSample: unknown;
  traceContext: string | null;
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
  linearInstallationId: string | null;
  linearTicketPolicy: LinearTicketPolicy;
  linearTicketInstructions: LinearTicketInstruction[];
  prPolicy: PrPolicy;
  githubConnected: boolean;
  customInstructions: string;
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
