import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunnerBackend, AgentRunnerSnapshot } from "../../agent-runner-backend.js";

const COMMUNITY_AGENT_MODEL = "community/static";

export const communityRunnerBackend: AgentRunnerBackend = {
  name: "community",
  maxRepoResources: 3,
  async start(input) {
    const sessionId = `community_${randomUUID()}`;
    const snapshot: AgentRunnerSnapshot = {
      sessionId,
      status: "terminated",
      stopReason: null,
      activeSeconds: 0,
      events: [
        {
          id: `${sessionId}:summary`,
          type: "message",
          processedAt: new Date().toISOString(),
          summary: "Community runner produced an incident summary.",
          detail: { runtime: "community" },
        },
      ],
      result: {
        state: "complete",
        summary: buildCommunitySummary(input.title, input.service, input.issueSummaries),
        pr: null,
        estimatedImpact: null,
        rootCause: null,
        rootCauseConfidence: null,
        noiseClassification: null,
        resolutionClassification: null,
      },
      unknownCustomTools: [],
      latestMessage: null,
      modelUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: COMMUNITY_AGENT_MODEL,
      },
    };
    await writeSnapshot(snapshot);
    return { sessionId };
  },
  async collect(sessionId) {
    return readSnapshot(sessionId);
  },
  async startChat() {
    // Chats need resumable provider sessions, which the static community
    // runner doesn't have. The chat tick surfaces this as a friendly Slack
    // reply instead of a silent failure.
    throw new Error("agent chats are not supported on the community runtime");
  },
  async sendChatMessage() {
    throw new Error("agent chats are not supported on the community runtime");
  },
  async resume() {
    throw new Error("community runner sessions cannot be resumed");
  },
  async steer() {
    throw new Error("community runner sessions cannot be steered");
  },
  async dispatchIntegrationToolCalls() {
    return 0;
  },
  async dispatchChatToolCalls() {
    return { handled: 0, repliesThisTurn: 0 };
  },
};

function buildCommunitySummary(
  title: string,
  service: string | null,
  issues: Array<{ title: string; exceptionType: string; message: string | null }>,
): string {
  const serviceText = service ? ` in ${service}` : "";
  const topIssue = issues[0];
  if (!topIssue) {
    return `Community investigation completed for "${title}"${serviceText}. No issue samples were attached, so no code fix was proposed.`;
  }
  const message = topIssue.message ? `: ${topIssue.message}` : "";
  return `Community investigation completed for "${title}"${serviceText}. Top issue: ${topIssue.title} (${topIssue.exceptionType})${message}. No code fix was proposed by the static community runner.`;
}

async function writeSnapshot(snapshot: AgentRunnerSnapshot): Promise<void> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  await writeFile(snapshotPath(snapshot.sessionId), `${JSON.stringify(snapshot, null, 2)}\n`);
}

async function readSnapshot(sessionId: string): Promise<AgentRunnerSnapshot> {
  const raw = await readFile(snapshotPath(sessionId), "utf8");
  return JSON.parse(raw) as AgentRunnerSnapshot;
}

function snapshotPath(sessionId: string): string {
  return join(stateDir(), `${sessionId}.json`);
}

function stateDir(): string {
  return (
    process.env.COMMUNITY_AGENT_RUNNER_STATE_DIR ??
    join(process.cwd(), "tmp", "community-agent-runs")
  );
}
