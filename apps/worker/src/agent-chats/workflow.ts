// Chat lifecycle orchestration, dependency-injected for tests (same pattern
// as agent-runs/start.ts). A chat is a durable provider session per Slack
// thread: `queued` delivers pending human messages (creating the session on
// first contact), `running` serves tool calls and watches for the turn to
// finish, `idle` waits for the next message. Replies reach Slack through the
// session's reply tool (dispatchChatToolCalls → onReply), with the session's
// last message as a fallback so a turn never ends in silence.
import type { AgentChat, AgentChatMessage, schema } from "@superlog/db";
import type {
  AgentChatDispatchResult,
  AgentRunnerBackend,
  AgentRunnerMemory,
  AgentRunnerRepoCandidate,
  AgentRunnerSnapshot,
} from "../agent-runner-backend.js";

// Hard per-thread compute cap. Chats have no per-project runtime setting; one
// conversation burning an hour of active session time is runaway, not Q&A.
export const CHAT_MAX_ACTIVE_SECONDS = parsePositiveInt(
  process.env.AGENT_CHAT_MAX_ACTIVE_SECONDS,
  3600,
  6 * 3600,
);

export const CHAT_BUDGET_EXHAUSTED_TEXT =
  ":hourglass: I've hit my compute budget for this conversation. Start a new thread if you'd like me to keep digging.";
export const CHAT_START_FAILED_TEXT =
  ":warning: I couldn't start on this question. Ask again in a bit, or check the project's agent settings in Superlog.";
export const CHAT_SESSION_LOST_TEXT =
  ":warning: My session ended unexpectedly. Ask again and I'll pick the thread back up.";
export const CHAT_NO_ANSWER_TEXT =
  "I finished without a concrete answer. Try rephrasing or narrowing the question.";

// Thrown by deps.postReply when the chat has no usable Slack target (token
// revoked, channel gone). The tick fails the chat quietly — there is nowhere
// to post an apology.
export class ChatDeliveryUnavailableError extends Error {}

export type AgentChatContext = {
  orgId: string;
  projectName: string;
  customInstructions: string;
  memories: AgentRunnerMemory[];
};

export type AgentChatPatch = Partial<
  Pick<
    AgentChat,
    | "state"
    | "providerSessionId"
    | "providerSessionStatus"
    | "failureReason"
    | "cumulativeActiveSeconds"
    | "lastSyncedAt"
    | "startedAt"
  >
>;

export type AgentChatWorkflowDeps = {
  getRunnerBackend(runtime: string): AgentRunnerBackend | Promise<AgentRunnerBackend>;
  loadChatContext(chat: AgentChat): Promise<AgentChatContext | null>;
  listRepoCandidates(chat: AgentChat, maxRepos: number): Promise<AgentRunnerRepoCandidate[]>;
  mcpResource: string | null;
  listPendingMessages(chatId: string): Promise<AgentChatMessage[]>;
  markMessagesProcessed(messageIds: string[]): Promise<void>;
  // Guarded state write: applies the patch only while the chat is still in
  // one of `whenState`; returns whether the row changed.
  updateChat(
    chatId: string,
    patch: AgentChatPatch,
    whenState?: schema.AgentChatState[],
  ): Promise<boolean>;
  // Posts to the chat's Slack thread; throws (ChatDeliveryUnavailableError
  // when no target exists) so tool acks and retries see the failure.
  // `dedupeId`, when set, must make the post idempotent across retries — a
  // reply whose provider ack failed is re-dispatched with the same id and
  // must not post twice. Omitted for one-shot lifecycle notices, which are
  // already guarded by their state transitions.
  postReply(chat: AgentChat, text: string, dedupeId?: string): Promise<void>;
  // Called once per finished turn, after the state transition commits.
  meterTurn(chat: AgentChat, snapshot: AgentRunnerSnapshot): Promise<void>;
};

// Deliver the queued human messages: into the existing durable session when
// one survives, else a fresh session carrying repos/memories/telemetry.
export async function processQueuedAgentChat(
  chat: AgentChat,
  deps: AgentChatWorkflowDeps,
): Promise<void> {
  const pending = await deps.listPendingMessages(chat.id);
  if (pending.length === 0) {
    // Normally unreachable (a chat is queued because a message arrived), but
    // a crash between processing and the state write can strand this. With a
    // session the sync handler sorts it out; without one there is nothing to
    // do until the next message.
    await deps.updateChat(chat.id, { state: chat.providerSessionId ? "running" : "idle" }, [
      "queued",
    ]);
    return;
  }

  const runner = await deps.getRunnerBackend(chat.runtime);
  const message = combineChatMessages(pending);

  // Claim before any provider call so two worker instances can't both start
  // a session for the same chat.
  const claimed = await deps.updateChat(chat.id, { state: "running" }, ["queued"]);
  if (!claimed) return;

  if (chat.providerSessionId) {
    try {
      await runner.sendChatMessage(chat.providerSessionId, message);
      await deps.markMessagesProcessed(pending.map((m) => m.id));
      return;
    } catch {
      // Provider reclaimed the durable session (TTL) — fall through to a
      // cold start with a fresh session.
    }
  }

  try {
    const context = await deps.loadChatContext(chat);
    if (!context) {
      await deps.updateChat(chat.id, { state: "failed", failureReason: "context_unavailable" }, [
        "running",
      ]);
      return;
    }
    const repoCandidates = await deps.listRepoCandidates(chat, runner.maxRepoResources);
    const session = await runner.startChat({
      chatId: chat.id,
      projectId: chat.projectId,
      orgId: context.orgId,
      projectName: context.projectName,
      question: message,
      requester: chat.createdBySlackUserId ? `<@${chat.createdBySlackUserId}>` : null,
      repoCandidates,
      mcpResource: deps.mcpResource,
      customInstructions: context.customInstructions,
      memories: context.memories,
    });
    await deps.markMessagesProcessed(pending.map((m) => m.id));
    await deps.updateChat(chat.id, {
      providerSessionId: session.sessionId,
      providerSessionStatus: "running",
      startedAt: chat.startedAt ?? new Date(),
    });
  } catch (err) {
    await deps.updateChat(chat.id, { state: "failed", failureReason: "start_failed" }, ["running"]);
    await deps.postReply(chat, CHAT_START_FAILED_TEXT);
    throw err;
  }
}

// Watch a running turn: serve tool calls (replies post immediately), steer in
// messages that arrived mid-turn, and on idle close the turn — with the
// fallback post when the agent never called the reply tool.
export async function syncRunningAgentChat(
  chat: AgentChat,
  deps: AgentChatWorkflowDeps,
): Promise<void> {
  const now = new Date();
  if (!chat.providerSessionId) {
    // Claimed by a start that crashed before creating the session; the
    // pending messages are still unprocessed, so re-queue and retry.
    await deps.updateChat(chat.id, { state: "queued" }, ["running"]);
    return;
  }
  const sessionId = chat.providerSessionId;
  const runner = await deps.getRunnerBackend(chat.runtime);

  const context = await deps.loadChatContext(chat);
  if (!context) {
    await deps.updateChat(chat.id, { state: "failed", failureReason: "context_unavailable" }, [
      "running",
    ]);
    return;
  }

  const dispatch: AgentChatDispatchResult = await runner.dispatchChatToolCalls({
    sessionId,
    orgId: context.orgId,
    projectId: chat.projectId,
    chatId: chat.id,
    onReply: (text, replyId) => deps.postReply(chat, text, replyId),
  });

  const snapshot = await runner.collect(sessionId);
  const progressPatch: AgentChatPatch = {
    providerSessionStatus: snapshot.status,
    cumulativeActiveSeconds: Math.max(
      Math.round(snapshot.activeSeconds),
      chat.cumulativeActiveSeconds,
    ),
    lastSyncedAt: now,
  };

  if (snapshot.activeSeconds > CHAT_MAX_ACTIVE_SECONDS) {
    const failed = await deps.updateChat(
      chat.id,
      { ...progressPatch, state: "failed", failureReason: "runtime_budget_exhausted" },
      ["running"],
    );
    if (failed) {
      await deps.meterTurn(chat, snapshot);
      await deps.postReply(chat, CHAT_BUDGET_EXHAUSTED_TEXT);
    }
    return;
  }

  // Messages that arrived mid-turn steer the live session instead of waiting
  // for the turn to end.
  const pending = await deps.listPendingMessages(chat.id);
  if (pending.length > 0) {
    await runner.sendChatMessage(sessionId, combineChatMessages(pending));
    await deps.markMessagesProcessed(pending.map((m) => m.id));
    await deps.updateChat(chat.id, progressPatch, ["running"]);
    return;
  }

  if (snapshot.status === "running" || snapshot.status === "rescheduling") {
    await deps.updateChat(chat.id, progressPatch, ["running"]);
    return;
  }

  if (snapshot.status === "idle") {
    // The reply tool is the delivery path; a turn that went idle without a
    // single reply still owes the human something.
    if (dispatch.repliesThisTurn === 0) {
      await deps.postReply(chat, snapshot.latestMessage?.trim() || CHAT_NO_ANSWER_TEXT);
    }
    const moved = await deps.updateChat(chat.id, { ...progressPatch, state: "idle" }, ["running"]);
    if (moved) await deps.meterTurn(chat, snapshot);
    // A message that landed between collect() and the transition would
    // otherwise sit unprocessed until the next inbound wakes the chat.
    const lagging = await deps.listPendingMessages(chat.id);
    if (lagging.length > 0) await deps.updateChat(chat.id, { state: "queued" }, ["idle"]);
    return;
  }

  // terminated: the provider ended the session. A new message re-queues the
  // chat; sendChatMessage will fail on the dead session and cold-start.
  if (dispatch.repliesThisTurn === 0 && snapshot.latestMessage?.trim()) {
    await deps.postReply(chat, snapshot.latestMessage.trim());
  }
  const failed = await deps.updateChat(
    chat.id,
    { ...progressPatch, state: "failed", failureReason: "session_terminated" },
    ["running"],
  );
  if (failed) {
    await deps.meterTurn(chat, snapshot);
    if (dispatch.repliesThisTurn === 0 && !snapshot.latestMessage?.trim()) {
      await deps.postReply(chat, CHAT_SESSION_LOST_TEXT);
    }
  }
}

// One inbound Slack message per row; several people can talk in the thread
// between turns, so keep the attribution visible to the agent.
export function combineChatMessages(messages: AgentChatMessage[]): string {
  return messages
    .map((m) => (m.authorSlackUserId ? `<@${m.authorSlackUserId}>: ${m.text}` : m.text))
    .join("\n\n");
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
