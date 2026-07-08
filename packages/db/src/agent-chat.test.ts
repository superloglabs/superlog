import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideChatInbound,
  mentionsBot,
  resolveChatInstallation,
  stripBotMention,
} from "./agent-chat.js";

// --- mention parsing -------------------------------------------------------

test("mentionsBot matches a plain bot mention token", () => {
  assert.equal(mentionsBot("<@U0BOT> what broke last night?", "U0BOT"), true);
});

test("mentionsBot matches a labelled mention token", () => {
  assert.equal(mentionsBot("hey <@U0BOT|superlog> what's up", "U0BOT"), true);
});

test("mentionsBot ignores mentions of other users and literal text", () => {
  assert.equal(mentionsBot("<@U0HUMAN> can you look?", "U0BOT"), false);
  assert.equal(mentionsBot("@superlog what broke", "U0BOT"), false);
  assert.equal(mentionsBot("<@U0BOTX> hi", "U0BOT"), false);
});

test("mentionsBot is false for a null bot user id", () => {
  assert.equal(mentionsBot("<@U0BOT> hi", null), false);
});

test("stripBotMention removes the bot token and tidies whitespace", () => {
  assert.equal(
    stripBotMention("<@U0BOT> what broke last night?", "U0BOT"),
    "what broke last night?",
  );
  assert.equal(stripBotMention("hey <@U0BOT|superlog>   what's up", "U0BOT"), "hey what's up");
});

test("stripBotMention keeps other users' mentions intact", () => {
  assert.equal(
    stripBotMention("<@U0BOT> ask <@U0HUMAN> about the deploy", "U0BOT"),
    "ask <@U0HUMAN> about the deploy",
  );
});

// --- workspace → project resolution ----------------------------------------

type InstallRow = Parameters<typeof resolveChatInstallation>[0][number];

function install(overrides: Partial<InstallRow> = {}): InstallRow {
  return {
    id: "inst-1",
    projectId: "proj-1",
    channelId: null,
    isDefaultChatProject: false,
    installedAt: new Date("2026-07-01T00:00:00Z"),
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

test("no installations resolves to none", () => {
  assert.deepEqual(resolveChatInstallation([], "C1"), { outcome: "none" });
});

test("a single installation wins regardless of channel", () => {
  const only = install();
  assert.deepEqual(resolveChatInstallation([only], "C_ANY"), {
    outcome: "resolved",
    installation: only,
  });
});

test("the installation routed to the mention channel wins over others", () => {
  const routed = install({ id: "inst-2", projectId: "proj-2", channelId: "C1" });
  const other = install({ id: "inst-3", projectId: "proj-3", isDefaultChatProject: true });
  assert.deepEqual(resolveChatInstallation([other, routed], "C1"), {
    outcome: "resolved",
    installation: routed,
  });
});

test("with no channel match the flagged default project wins", () => {
  const flagged = install({ id: "inst-2", projectId: "proj-2", isDefaultChatProject: true });
  const other = install({ id: "inst-3", projectId: "proj-3" });
  assert.deepEqual(resolveChatInstallation([other, flagged], "C_ELSEWHERE"), {
    outcome: "resolved",
    installation: flagged,
  });
});

test("several channel matches prefer the flagged one, then token recency", () => {
  const older = install({
    id: "inst-2",
    channelId: "C1",
    installedAt: new Date("2026-06-10T00:00:00Z"),
  });
  const newer = install({
    id: "inst-3",
    channelId: "C1",
    installedAt: new Date("2026-07-05T00:00:00Z"),
  });
  assert.deepEqual(resolveChatInstallation([older, newer], "C1"), {
    outcome: "resolved",
    installation: newer,
  });
  const flagged = install({ id: "inst-4", channelId: "C1", isDefaultChatProject: true });
  assert.deepEqual(resolveChatInstallation([older, flagged, newer], "C1"), {
    outcome: "resolved",
    installation: flagged,
  });
});

test("multiple projects with no channel match and no default is ambiguous", () => {
  const a = install({ id: "inst-2", projectId: "proj-2" });
  const b = install({ id: "inst-3", projectId: "proj-3" });
  assert.deepEqual(resolveChatInstallation([a, b], "C_ELSEWHERE"), { outcome: "ambiguous" });
});

test("legacy rows without installedAt fall back to createdAt for recency", () => {
  const legacy = install({
    id: "inst-2",
    channelId: "C1",
    installedAt: null,
    createdAt: new Date("2026-07-06T00:00:00Z"),
  });
  const dated = install({
    id: "inst-3",
    channelId: "C1",
    installedAt: new Date("2026-07-01T00:00:00Z"),
  });
  assert.deepEqual(resolveChatInstallation([dated, legacy], "C1"), {
    outcome: "resolved",
    installation: legacy,
  });
});

// --- inbound routing --------------------------------------------------------

test("chat disabled skips regardless of an existing chat", () => {
  assert.deepEqual(decideChatInbound({ chatEnabled: false, existingChat: null }), {
    action: "skip",
    reason: "chat_disabled",
  });
  assert.deepEqual(
    decideChatInbound({ chatEnabled: false, existingChat: { id: "chat-1", state: "idle" } }),
    { action: "skip", reason: "chat_disabled" },
  );
});

test("no existing chat creates one", () => {
  assert.deepEqual(decideChatInbound({ chatEnabled: true, existingChat: null }), {
    action: "create",
  });
});

test("idle and failed chats are re-queued on a new message", () => {
  assert.deepEqual(
    decideChatInbound({ chatEnabled: true, existingChat: { id: "chat-1", state: "idle" } }),
    { action: "append", chatId: "chat-1", requeue: true },
  );
  assert.deepEqual(
    decideChatInbound({ chatEnabled: true, existingChat: { id: "chat-1", state: "failed" } }),
    { action: "append", chatId: "chat-1", requeue: true },
  );
});

test("queued and running chats absorb the message without a state change", () => {
  assert.deepEqual(
    decideChatInbound({ chatEnabled: true, existingChat: { id: "chat-1", state: "queued" } }),
    { action: "append", chatId: "chat-1", requeue: false },
  );
  assert.deepEqual(
    decideChatInbound({ chatEnabled: true, existingChat: { id: "chat-1", state: "running" } }),
    { action: "append", chatId: "chat-1", requeue: false },
  );
});
