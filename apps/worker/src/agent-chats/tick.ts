import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  createLinearAgentActivity,
  db,
  listAccessibleGithubInstallsForProject,
  listActiveAgentChats,
  listPendingChatMessages,
  markChatMessagesProcessed,
  schema,
} from "@superlog/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { listActiveAgentMemories } from "../agent-memory-tools.js";
import { listAccessibleGithubRepositories } from "../agent-run-context.js";
import type { AgentRunnerRepoCandidate } from "../agent-runner-backend.js";
import { recordTokenUsage } from "../ai-usage.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import {
  createRepositoryReadToken,
  listRepositoryInstructionFiles,
} from "../infra/github/repositories.js";
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
const CHAT_INSTRUCTION_FILE_PROBE_LIMIT = 10;

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
      columns: { customInstructions: true, chatEnabled: true },
    });
    const memories = await listActiveAgentMemories(project.orgId, chat.projectId);
    return {
      orgId: project.orgId,
      projectName: project.name,
      chatEnabled: automation?.chatEnabled ?? true,
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
      repos.map(async (repo, index): Promise<AgentRunnerRepoCandidate | null> => {
        try {
          const installationToken = await createRepositoryReadToken(
            repo.installation.installationId,
            repo.id,
          );
          return {
            fullName: repo.fullName,
            cloneUrl: `https://github.com/${repo.fullName}`,
            installationToken,
            score: 0,
            // Same cap rationale as agent runs: the probe costs GitHub API
            // requests per repo, so only the first few mounted repos get one.
            instructionFiles:
              index < CHAT_INSTRUCTION_FILE_PROBE_LIMIT
                ? await listRepositoryInstructionFiles(installationToken, repo.fullName).catch(
                    () => [],
                  )
                : [],
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
      await postAgentChatReply(chat, text);
      return;
    }
    await postReplyExactlyOnce(chat, text, dedupeId, 0);
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

// How long another dispatcher's unposted claim is trusted before we assume
// it crashed mid-post and take the reply over. Safe because the chat post
// itself is aborted at CHAT_POST_TIMEOUT_MS (chat-messages.ts), far below
// this window — by the time a claim looks stale, no original post can still
// be in flight, so the takeover can't race a slow post into a duplicate.
const OUTBOUND_CLAIM_TAKEOVER_MS = 2 * 60 * 1000;

async function postAgentChatReply(chat: schema.AgentChat, text: string): Promise<string> {
  if (chat.provider !== "linear") return postAgentChatMessage(chat, text);
  const session = await db.query.linearAgentSessions.findFirst({
    where: eq(schema.linearAgentSessions.agentChatId, chat.id),
  });
  if (!session) throw new ChatDeliveryUnavailableError("Linear agent session is missing");
  const installation = await db.query.linearInstallations.findFirst({
    where: and(
      eq(schema.linearInstallations.id, session.installationId),
      isNull(schema.linearInstallations.revokedAt),
    ),
  });
  if (!installation) throw new ChatDeliveryUnavailableError("Linear installation is unavailable");
  const activity = await createLinearAgentActivity({
    accessToken: installation.accessToken,
    agentSessionId: session.agentSessionId,
    type: "response",
    body: text,
  });
  return activity.id;
}

// Deliver one reply at most once across concurrent dispatchers and provider
// ack retries. The claim row (unique on chatId + `outbound:<replyId>`) has
// two states: in-flight (slackMessageTs NULL) and posted (slackMessageTs
// set after the Slack call succeeds). Returning normally means "safe to ack
// the provider tool call"; a conflict with an in-flight claim throws instead,
// because delivery by the other worker is not yet KNOWN to have happened —
// acking there could silently lose the reply if that worker's post fails.
// Stale in-flight claims (crash between post and marker write, or before the
// post) are taken over after a timeout, so a wedged reply retries rather
// than blocking the session forever. processedAt is pre-set so outbound
// markers never surface as pending inbound messages.
async function postReplyExactlyOnce(
  chat: schema.AgentChat,
  text: string,
  replyId: string,
  attempt: number,
): Promise<void> {
  const dedupeKey = `outbound:${replyId}`;
  const [claim] = await db
    .insert(schema.agentChatMessages)
    .values({
      chatId: chat.id,
      authorSlackUserId: null,
      text,
      slackMessageTs: null,
      dedupeKey,
      processedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [schema.agentChatMessages.chatId, schema.agentChatMessages.dedupeKey],
    })
    .returning({ id: schema.agentChatMessages.id });

  if (!claim) {
    const existing = await db.query.agentChatMessages.findFirst({
      where: and(
        eq(schema.agentChatMessages.chatId, chat.id),
        eq(schema.agentChatMessages.dedupeKey, dedupeKey),
      ),
    });
    // Posted by an earlier pass or another worker — done, safe to ack.
    if (existing?.providerMessageId ?? existing?.slackMessageTs) return;
    if (existing && Date.now() - existing.createdAt.getTime() < OUTBOUND_CLAIM_TAKEOVER_MS) {
      throw new Error("chat reply delivery in flight by another dispatcher; retrying next tick");
    }
    if (existing) {
      // Stale in-flight claim: the owner crashed. Release it (guarded on
      // still-unposted so a racing completion wins) and retry the claim.
      await db
        .delete(schema.agentChatMessages)
        .where(
          and(
            eq(schema.agentChatMessages.id, existing.id),
            isNull(schema.agentChatMessages.providerMessageId),
            isNull(schema.agentChatMessages.slackMessageTs),
          ),
        );
    }
    if (attempt >= 2) {
      throw new Error("chat reply claim contention; retrying next tick");
    }
    return postReplyExactlyOnce(chat, text, replyId, attempt + 1);
  }

  let postedTs: string;
  try {
    postedTs = await postAgentChatReply(chat, text);
  } catch (err) {
    await db
      .delete(schema.agentChatMessages)
      .where(eq(schema.agentChatMessages.id, claim.id))
      .catch(() => {});
    throw err;
  }
  await db
    .update(schema.agentChatMessages)
    .set({ providerMessageId: postedTs })
    .where(eq(schema.agentChatMessages.id, claim.id));
}

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
