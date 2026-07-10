import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncidentEvent } from "../api.ts";
import { buildActivityFeed, markAwaitingQuestion } from "./incident-activity-feed.ts";
import { memoryActivityFromTool } from "./memory-tool-activity.ts";

function event(overrides: Partial<IncidentEvent>): IncidentEvent {
  return {
    id: "event-1",
    agentRunId: "run-1",
    kind: "agent.message",
    summary: null,
    detail: null,
    createdAt: "2026-07-09T00:37:38.370Z",
    ...overrides,
  };
}

test("buildActivityFeed starts with the issue that triggered the incident", () => {
  const feed = buildActivityFeed(
    [event({ kind: "agent_run_queued", summary: "Investigation queued." })],
    {
      triggeringIssue: {
        issueId: "issue-1",
        createdAt: "2026-07-09T00:26:18.068Z",
      },
    },
  );

  assert.deepEqual(feed[0], {
    type: "triggering_issue",
    id: "triggering-issue-issue-1",
    issueId: "issue-1",
    createdAt: "2026-07-09T00:26:18.068Z",
  });
});

test("buildActivityFeed turns ask_human into a question node with the exact prompt", () => {
  const feed = buildActivityFeed([
    event({
      id: "ask-1",
      kind: "agent.custom_tool_use",
      detail: {
        toolUse: {
          name: "ask_human",
          input: { question: "Which remediation path should we take?" },
        },
      },
    }),
  ]);

  assert.deepEqual(feed, [
    {
      type: "question",
      id: "ask-1",
      question: "Which remediation path should we take?",
      awaiting: false,
    },
  ]);
});

test("markAwaitingQuestion marks the latest repeated ask_human prompt", () => {
  const feed = buildActivityFeed([
    event({
      id: "ask-1",
      kind: "agent.custom_tool_use",
      detail: {
        toolUse: {
          name: "ask_human",
          input: { question: "Which remediation path should we take?" },
        },
      },
    }),
    event({
      id: "ask-2",
      kind: "agent.custom_tool_use",
      detail: {
        toolUse: {
          name: "ask_human",
          input: { question: "Which remediation path should we take?" },
        },
      },
    }),
  ]);

  assert.deepEqual(markAwaitingQuestion(feed, "Which remediation path should we take?"), [
    {
      type: "question",
      id: "ask-1",
      question: "Which remediation path should we take?",
      awaiting: false,
    },
    {
      type: "question",
      id: "ask-2",
      question: "Which remediation path should we take?",
      awaiting: true,
    },
  ]);
});

test("memoryActivityFromTool decorates save_memory calls as memory activity", () => {
  assert.deepEqual(
    memoryActivityFromTool(
      "tool-use-1",
      "save_memory",
      {
        kind: "infra",
        title: "Deploy window",
        body: "Deploys happen during the US morning support window.",
      },
      '{"ok":true,"id":"mem-1"}',
      false,
    ),
    {
      type: "memory",
      id: "tool-use-1",
      action: "saved",
      kind: "infra",
      memoryId: "mem-1",
      status: null,
      title: "Deploy window",
      body: "Deploys happen during the US morning support window.",
      result: '{"ok":true,"id":"mem-1"}',
      isError: false,
    },
  );
});

test("memoryActivityFromTool decorates update_memory calls as memory activity", () => {
  assert.deepEqual(
    memoryActivityFromTool(
      "tool-use-2",
      "update_memory",
      {
        id: "mem-existing",
        status: "archived",
      },
      '{"ok":true,"id":"mem-existing"}',
      false,
    ),
    {
      type: "memory",
      id: "tool-use-2",
      action: "updated",
      kind: null,
      memoryId: "mem-existing",
      status: "archived",
      title: null,
      body: null,
      result: '{"ok":true,"id":"mem-existing"}',
      isError: false,
    },
  );
});

test("memoryActivityFromTool ignores non-memory tools", () => {
  assert.equal(
    memoryActivityFromTool("tool-use-3", "query_logs", { search: "error" }, "[]", false),
    null,
  );
});

test("memoryActivityFromTool preserves failed memory tool results", () => {
  assert.deepEqual(
    memoryActivityFromTool(
      "tool-use-4",
      "save_memory",
      {
        kind: "infra",
        title: "Deploy window",
        body: "Deploys happen during the US morning support window.",
      },
      '{"error":"memory tools unavailable"}',
      true,
    ),
    {
      type: "memory",
      id: "tool-use-4",
      action: "saved",
      kind: "infra",
      memoryId: null,
      status: null,
      title: "Deploy window",
      body: "Deploys happen during the US morning support window.",
      result: '{"error":"memory tools unavailable"}',
      isError: true,
    },
  );
});
