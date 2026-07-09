import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentChat, AgentChatMessage } from "@superlog/db";
import type {
  AgentChatStartInput,
  AgentRunnerBackend,
  AgentRunnerSnapshot,
} from "../agent-runner-backend.js";
import {
  type AgentChatWorkflowDeps,
  CHAT_BUDGET_EXHAUSTED_TEXT,
  CHAT_MAX_ACTIVE_SECONDS,
  CHAT_NO_ANSWER_TEXT,
  combineChatMessages,
  processQueuedAgentChat,
  syncRunningAgentChat,
} from "./workflow.js";

function chat(overrides: Partial<AgentChat> = {}): AgentChat {
  return {
    id: "chat-1",
    projectId: "proj-1",
    slackInstallationId: "inst-1",
    slackTeamId: "T1",
    slackChannelId: "C1",
    slackThreadTs: "111.222",
    createdBySlackUserId: "U1",
    title: "what broke?",
    runtime: "anthropic",
    state: "queued",
    providerSessionId: null,
    providerSessionStatus: null,
    failureReason: null,
    cumulativeActiveSeconds: 0,
    sessionBaseActiveSeconds: 0,
    lastSyncedAt: null,
    startedAt: null,
    createdAt: new Date("2026-07-08T10:00:00Z"),
    updatedAt: new Date("2026-07-08T10:00:00Z"),
    ...overrides,
  };
}

function message(overrides: Partial<AgentChatMessage> = {}): AgentChatMessage {
  return {
    id: "msg-1",
    chatId: "chat-1",
    authorSlackUserId: "U1",
    text: "what broke last night?",
    slackMessageTs: "111.222",
    dedupeKey: "slackchat:C1:111.222",
    processedAt: null,
    createdAt: new Date("2026-07-08T10:00:00Z"),
    ...overrides,
  };
}

function snapshot(overrides: Partial<AgentRunnerSnapshot> = {}): AgentRunnerSnapshot {
  return {
    sessionId: "session-1",
    status: "idle",
    activeSeconds: 30,
    events: [],
    result: null,
    unknownCustomTools: [],
    latestMessage: "The deploy at 02:10 broke checkout.",
    modelUsage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: "test-model",
    },
    ...overrides,
  };
}

type Harness = {
  deps: AgentChatWorkflowDeps;
  calls: string[];
  updates: Array<{ patch: Record<string, unknown>; whenState?: string[] }>;
  replies: string[];
};

function makeHarness(opts: {
  pending?: AgentChatMessage[];
  runner?: Partial<AgentRunnerBackend>;
  repliesThisTurn?: number;
  snapshot?: AgentRunnerSnapshot;
  chatEnabled?: boolean;
  onStartChat?: (input: AgentChatStartInput) => void;
}): Harness {
  const calls: string[] = [];
  const updates: Array<{ patch: Record<string, unknown>; whenState?: string[] }> = [];
  const replies: string[] = [];
  let pending = opts.pending ?? [message()];

  const runner: AgentRunnerBackend = {
    name: "fake",
    maxRepoResources: 5,
    async start() {
      throw new Error("not used");
    },
    async startChat(input) {
      calls.push(`startChat:${input.question}`);
      opts.onStartChat?.(input);
      return { sessionId: "session-new" };
    },
    async sendChatMessage(sessionId, text) {
      calls.push(`send:${sessionId}:${text}`);
    },
    async collect() {
      calls.push("collect");
      return opts.snapshot ?? snapshot();
    },
    async resume() {
      throw new Error("not used");
    },
    async steer() {
      throw new Error("not used");
    },
    async dispatchIntegrationToolCalls() {
      throw new Error("not used");
    },
    async dispatchChatToolCalls(input) {
      calls.push("dispatchChatToolCalls");
      return { handled: 0, repliesThisTurn: opts.repliesThisTurn ?? 0 };
    },
    ...opts.runner,
  };

  const deps: AgentChatWorkflowDeps = {
    getRunnerBackend: () => runner,
    async loadChatContext() {
      return {
        orgId: "org-1",
        projectName: "Acme",
        chatEnabled: opts.chatEnabled ?? true,
        customInstructions: "",
        memories: [],
      };
    },
    async listRepoCandidates() {
      return [
        {
          fullName: "acme/app",
          cloneUrl: "https://github.com/acme/app",
          installationToken: "t",
          score: 0,
          instructionFiles: [],
        },
      ];
    },
    mcpResource: "https://api.example.com/mcp",
    async listPendingMessages() {
      return pending;
    },
    async markMessagesProcessed(ids) {
      calls.push(`processed:${ids.join(",")}`);
      pending = pending.filter((m) => !ids.includes(m.id));
    },
    async updateChat(_chatId, patch, whenState) {
      updates.push({ patch: patch as Record<string, unknown>, whenState });
      return true;
    },
    async postReply(_chat, text) {
      replies.push(text);
    },
    async meterTurn() {
      calls.push("meterTurn");
    },
  };

  return { deps, calls, updates, replies };
}

test("first message starts a fresh session with repos and question", async () => {
  const h = makeHarness({});
  await processQueuedAgentChat(chat(), h.deps);

  assert.ok(h.calls.some((c) => c.startsWith("startChat:<@U1>: what broke last night?")));
  assert.ok(h.calls.includes("processed:msg-1"));
  // Claimed queued -> running before the provider call.
  assert.deepEqual(h.updates[0], { patch: { state: "running" }, whenState: ["queued"] });
  const sessionPatch = h.updates.find((u) => u.patch.providerSessionId);
  assert.equal(sessionPatch?.patch.providerSessionId, "session-new");
});

test("queued chat with a live session resumes it instead of starting fresh", async () => {
  const h = makeHarness({});
  await processQueuedAgentChat(chat({ providerSessionId: "session-old" }), h.deps);

  assert.ok(h.calls.some((c) => c.startsWith("send:session-old:")));
  assert.ok(!h.calls.some((c) => c.startsWith("startChat:")));
  assert.ok(h.calls.includes("processed:msg-1"));
});

test("a reclaimed session cold-starts a fresh one", async () => {
  const h = makeHarness({
    runner: {
      async sendChatMessage() {
        throw new Error("session not found");
      },
    },
  });
  await processQueuedAgentChat(chat({ providerSessionId: "session-dead" }), h.deps);

  assert.ok(h.calls.some((c) => c.startsWith("startChat:")));
  const sessionPatch = h.updates.find((u) => u.patch.providerSessionId);
  assert.equal(sessionPatch?.patch.providerSessionId, "session-new");
});

test("startChat failure fails the chat and posts a notice", async () => {
  const h = makeHarness({
    runner: {
      async startChat() {
        throw new Error("boom");
      },
    },
  });
  await assert.rejects(() => processQueuedAgentChat(chat(), h.deps));

  const failure = h.updates.find((u) => u.patch.state === "failed");
  assert.equal(failure?.patch.failureReason, "start_failed");
  assert.equal(h.replies.length, 1);
});

test("idle turn with tool replies transitions to idle and meters once", async () => {
  const h = makeHarness({ pending: [], repliesThisTurn: 1 });
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: "session-1" }), h.deps);

  assert.deepEqual(h.replies, []);
  const idle = h.updates.find((u) => u.patch.state === "idle");
  assert.ok(idle);
  assert.ok(h.calls.includes("meterTurn"));
});

test("idle turn without a reply falls back to the session's last message", async () => {
  const h = makeHarness({ pending: [], repliesThisTurn: 0 });
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: "session-1" }), h.deps);

  assert.deepEqual(h.replies, ["The deploy at 02:10 broke checkout."]);
});

test("idle turn with no reply and no last message posts the no-answer text", async () => {
  const h = makeHarness({
    pending: [],
    repliesThisTurn: 0,
    snapshot: snapshot({ latestMessage: null }),
  });
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: "session-1" }), h.deps);

  assert.deepEqual(h.replies, [CHAT_NO_ANSWER_TEXT]);
});

test("messages arriving mid-turn steer the live session and stay running", async () => {
  const h = makeHarness({
    pending: [message({ id: "msg-2", text: "actually check the proxy" })],
    snapshot: snapshot({ status: "running" }),
  });
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: "session-1" }), h.deps);

  assert.ok(h.calls.some((c) => c.startsWith("send:session-1:")));
  assert.ok(h.calls.includes("processed:msg-2"));
  assert.ok(!h.updates.some((u) => u.patch.state === "idle"));
});

test("blowing the compute budget fails the chat with a notice", async () => {
  const h = makeHarness({
    pending: [],
    snapshot: snapshot({ activeSeconds: CHAT_MAX_ACTIVE_SECONDS + 1 }),
  });
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: "session-1" }), h.deps);

  const failure = h.updates.find((u) => u.patch.state === "failed");
  assert.equal(failure?.patch.failureReason, "runtime_budget_exhausted");
  assert.deepEqual(h.replies, [CHAT_BUDGET_EXHAUSTED_TEXT]);
});

test("terminated session fails the chat after salvaging the last message", async () => {
  const h = makeHarness({
    pending: [],
    snapshot: snapshot({ status: "terminated" }),
  });
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: "session-1" }), h.deps);

  assert.deepEqual(h.replies, ["The deploy at 02:10 broke checkout."]);
  const failure = h.updates.find((u) => u.patch.state === "failed");
  assert.equal(failure?.patch.failureReason, "session_terminated");
});

test("running chat without a session re-queues for a clean start", async () => {
  const h = makeHarness({});
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: null }), h.deps);

  assert.deepEqual(h.updates, [{ patch: { state: "queued" }, whenState: ["running"] }]);
});

test("combineChatMessages keeps author attribution", () => {
  const combined = combineChatMessages([
    message({ text: "what broke?" }),
    message({ id: "m2", authorSlackUserId: "U2", text: "also check checkout" }),
    message({ id: "m3", authorSlackUserId: null, text: "anonymous note" }),
  ]);
  assert.equal(combined, "<@U1>: what broke?\n\n<@U2>: also check checkout\n\nanonymous note");
});

test("disabling chat parks queued chats without failing them", async () => {
  const h = makeHarness({ chatEnabled: false });
  await processQueuedAgentChat(chat(), h.deps);

  assert.deepEqual(h.updates, [{ patch: { state: "idle" }, whenState: ["queued"] }]);
  assert.ok(!h.calls.some((c) => c.startsWith("startChat:")));
});

test("disabling chat parks running chats before serving tools", async () => {
  const h = makeHarness({ chatEnabled: false });
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: "session-1" }), h.deps);

  assert.ok(!h.calls.includes("dispatchChatToolCalls"));
  const parked = h.updates.find((u) => u.patch.state === "idle");
  assert.ok(parked);
});

test("the compute budget counts prior sessions via the recorded base", async () => {
  const h = makeHarness({
    pending: [],
    snapshot: snapshot({ activeSeconds: 100 }),
  });
  await syncRunningAgentChat(
    chat({
      state: "running",
      providerSessionId: "session-2",
      sessionBaseActiveSeconds: CHAT_MAX_ACTIVE_SECONDS - 50,
      cumulativeActiveSeconds: CHAT_MAX_ACTIVE_SECONDS - 50,
    }),
    h.deps,
  );

  const failure = h.updates.find((u) => u.patch.state === "failed");
  assert.equal(failure?.patch.failureReason, "runtime_budget_exhausted");
});

test("a terminated session with pending text re-queues for a cold start", async () => {
  const h = makeHarness({
    pending: [message({ id: "msg-2", text: "still there?" })],
    snapshot: snapshot({ status: "terminated" }),
  });
  await syncRunningAgentChat(chat({ state: "running", providerSessionId: "session-1" }), h.deps);

  // The dead session must not be steered — the pending row survives for the
  // cold start.
  assert.ok(!h.calls.some((c) => c.startsWith("send:")));
  assert.ok(!h.calls.includes("processed:msg-2"));
  const requeued = h.updates.find((u) => u.patch.state === "queued");
  assert.equal(requeued?.patch.providerSessionId, null);
});

test("a fresh start persists the session before acknowledging messages", async () => {
  const order: string[] = [];
  const h = makeHarness({
    onStartChat: () => order.push("startChat"),
  });
  const baseUpdate = h.deps.updateChat.bind(h.deps);
  h.deps.updateChat = async (chatId, patch, whenState) => {
    if (patch.providerSessionId) order.push("persistSession");
    return baseUpdate(chatId, patch, whenState);
  };
  const baseMark = h.deps.markMessagesProcessed.bind(h.deps);
  h.deps.markMessagesProcessed = async (ids) => {
    order.push("markProcessed");
    return baseMark(ids);
  };

  await processQueuedAgentChat(chat(), h.deps);

  assert.deepEqual(order, ["startChat", "persistSession", "markProcessed"]);
});
