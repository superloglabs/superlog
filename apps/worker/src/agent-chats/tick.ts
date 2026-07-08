import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  db,
  listAccessibleGithubInstallsForProject,
  listActiveAgentChats,
  listPendingChatMessages,
  markChatMessagesProcessed,
  schema,
} from "@superlog/db";
import { and, eq, inArray } from "drizzle-orm";
import { listActiveAgentMemories } from "../agent-memory-tools.js";
import { listAccessibleGithubRepositories } from "../agent-run-context.js";
import type { AgentRunnerRepoCandidate } from "../agent-runner-backend.js";
import { recordTokenUsage } from "../ai-usage.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import { createRepositoryReadToken } from "../infra/github/repositories.js";
import { postAgentChatMessage } from "../infra/slack/chat-messages.js";
import { logger } from "../logger.js";
import {
  type AgentChatWorkflowDeps,
  ChatDeliveryUnavailableError,
  processQueuedAgentChat,
  syncRunningAgentChat,
} from "./workflow.js";

const tracer = trace.getTracer("@superlog/worker");
const log = logger.child({ scope: "agent_chat" });

const AGENT_CHAT_BATCH_SIZE = parsePositiveInt(process.env.AGENT_CHAT_BATCH_SIZE, 10, 100);

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

const deps: AgentChatWorkflowDeps = {
  getRunnerBackend: getAgentRunnerBackend,
  async loadChatContext(chat) {
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, chat.projectId),
    });
    if (!project) return null;
    const automation = await db.query.projectAutomationSettings.findFirst({
      where: eq(schema.projectAutomationSettings.projectId, chat.projectId),
      columns: { customInstructions: true },
    });
    const memories = await listActiveAgentMemories(project.orgId, chat.projectId);
    return {
      orgId: project.orgId,
      projectName: project.name,
      customInstructions: automation?.customInstructions ?? "",
      memories: memories.map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        title: memory.title,
        body: memory.body,
      })),
    };
  },
  async listRepoCandidates(chat, maxRepos) {
    const githubInstalls = await listAccessibleGithubInstallsForProject(chat.projectId);
    if (githubInstalls.length === 0) return [];
    // No incident to score against — mount up to the cap in listing order.
    // Questions can reference any repo, and the agent picks its own path.
    const repos = (await listAccessibleGithubRepositories({ githubInstalls })).slice(0, maxRepos);
    const candidates = await Promise.all(
      repos.map(async (repo): Promise<AgentRunnerRepoCandidate | null> => {
        try {
          return {
            fullName: repo.fullName,
            cloneUrl: `https://github.com/${repo.fullName}`,
            installationToken: await createRepositoryReadToken(
              repo.installation.installationId,
              repo.id,
            ),
            score: 0,
          };
        } catch (err) {
          log.warn({ err, repo: repo.fullName }, "skipping inaccessible repo for agent chat");
          return null;
        }
      }),
    );
    return candidates.filter((repo): repo is AgentRunnerRepoCandidate => repo !== null);
  },
  mcpResource: `${(process.env.API_BASE_URL ?? "https://api.superlog.sh").replace(/\/$/, "")}/mcp`,
  listPendingMessages: (chatId) => listPendingChatMessages(db, chatId),
  markMessagesProcessed: (messageIds) => markChatMessagesProcessed(db, messageIds),
  async updateChat(chatId, patch, whenState) {
    const rows = await db
      .update(schema.agentChats)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        whenState
          ? and(eq(schema.agentChats.id, chatId), inArray(schema.agentChats.state, whenState))
          : eq(schema.agentChats.id, chatId),
      )
      .returning({ id: schema.agentChats.id });
    return rows.length > 0;
  },
  async postReply(chat, text, dedupeId) {
    if (!dedupeId) {
      await postAgentChatMessage(chat, text);
      return;
    }
    // Idempotency across dispatch retries: a reply that posted but whose
    // provider ack failed is re-dispatched with the same id. Claim a marker
    // row first (unique on chatId+dedupeKey); a conflict means an earlier
    // pass already posted this reply, so just let the caller re-ack. The
    // claim is released on post failure so a transient Slack error retries
    // instead of silently dropping the reply. processedAt is pre-set so the
    // marker never surfaces as a pending inbound message.
    const [claim] = await db
      .insert(schema.agentChatMessages)
      .values({
        chatId: chat.id,
        authorSlackUserId: null,
        text,
        slackMessageTs: null,
        dedupeKey: `outbound:${dedupeId}`,
        processedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [schema.agentChatMessages.chatId, schema.agentChatMessages.dedupeKey],
      })
      .returning({ id: schema.agentChatMessages.id });
    if (!claim) return;
    try {
      await postAgentChatMessage(chat, text);
    } catch (err) {
      await db
        .delete(schema.agentChatMessages)
        .where(eq(schema.agentChatMessages.id, claim.id))
        .catch(() => {});
      throw err;
    }
  },
  async meterTurn(chat, snapshot) {
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, chat.projectId),
      columns: { orgId: true },
    });
    if (!project) return;
    await recordTokenUsage({
      orgId: project.orgId,
      projectId: chat.projectId,
      model: snapshot.modelUsage.model,
      callSite: "agent_chat",
      usage: snapshot.modelUsage,
    });
  },
};

export async function tickAgentChats(): Promise<number> {
  return tracer.startActiveSpan("agent_chats.tick", async (span) => {
    try {
      const chats = await listActiveAgentChats(db, AGENT_CHAT_BATCH_SIZE);
      let processed = 0;
      for (const chat of chats) {
        // Same starvation guard as the agent-runs tick: touch every visited
        // row so a handler that returns without writing doesn't pin the top
        // of the asc(updatedAt) queue.
        await db
          .update(schema.agentChats)
          .set({ updatedAt: new Date() })
          .where(eq(schema.agentChats.id, chat.id));
        try {
          if (chat.state === "queued") await processQueuedAgentChat(chat, deps);
          else if (chat.state === "running") await syncRunningAgentChat(chat, deps);
          processed += 1;
        } catch (err) {
          if (err instanceof ChatDeliveryUnavailableError) {
            // Nowhere to post — Slack install revoked or channel gone. Fail
            // quietly; a later message (post-reinstall) re-queues the chat.
            await deps.updateChat(chat.id, { state: "failed", failureReason: "slack_unreachable" });
            log.warn({ chat_id: chat.id, err: err.message }, "agent chat slack target unavailable");
            continue;
          }
          log.error(
            { chat_id: chat.id, err: err instanceof Error ? err.message : String(err) },
            "agent chat tick step failed",
          );
        }
      }
      span.setAttribute("agent_chats.processed", processed);
      return processed;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
