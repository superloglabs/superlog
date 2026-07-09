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
