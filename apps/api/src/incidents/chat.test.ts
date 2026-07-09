import assert from "node:assert/strict";
import { test } from "node:test";
import { INCIDENT_CHAT_MAX_LENGTH, prepareIncidentChatMessage } from "./chat.js";

const NOW = new Date("2026-07-09T12:00:00Z");

test("builds a web_chat interaction from a valid message", () => {
  const result = prepareIncidentChatMessage({
    text: "  please rename the flag in the PR  ",
    messageId: "0d4f9c1e-6f0f-4d34-9b56-1a2b3c4d5e6f",
    author: "Ada Lovelace",
    now: NOW,
  });
  assert.deepEqual(result, {
    ok: true,
    interaction: {
      channel: "web_chat",
      author: "Ada Lovelace",
      text: "please rename the flag in the PR",
      occurredAt: NOW.toISOString(),
    },
    dedupeKey: "web_chat:0d4f9c1e-6f0f-4d34-9b56-1a2b3c4d5e6f",
  });
});

test("rejects empty or whitespace-only messages", () => {
  for (const text of ["", "   ", "\n\t"]) {
    assert.deepEqual(
      prepareIncidentChatMessage({ text, messageId: "m1", author: null, now: NOW }),
      {
        ok: false,
        error: "empty_message",
      },
    );
  }
});

test("rejects messages over the length cap", () => {
  const result = prepareIncidentChatMessage({
    text: "x".repeat(INCIDENT_CHAT_MAX_LENGTH + 1),
    messageId: "m1",
    author: null,
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, error: "message_too_long" });
});

test("rejects a missing or malformed client message id (dedupe key must be stable)", () => {
  for (const messageId of ["", "  ", "not/a/safe*key", "x".repeat(129)]) {
    assert.deepEqual(
      prepareIncidentChatMessage({ text: "hello", messageId, author: null, now: NOW }),
      { ok: false, error: "invalid_message_id" },
    );
  }
});

test("null author is preserved (falls back to null, not empty string)", () => {
  const result = prepareIncidentChatMessage({
    text: "hi",
    messageId: "m-1",
    author: null,
    now: NOW,
  });
  assert.ok(result.ok);
  assert.equal(result.interaction.author, null);
});
