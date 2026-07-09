import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryActivityFromTool } from "./memory-tool-activity.ts";

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
