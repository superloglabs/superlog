import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  type AgentMemoryToolDeps,
  LIST_MEMORIES_TOOL_NAME,
  SAVE_MEMORY_TOOL_NAME,
  UPDATE_MEMORY_TOOL_NAME,
  agentMemoryToolParams,
  executeAgentMemoryTool,
  isAgentMemoryToolName,
} from "./agent-memory-tools.js";

const ctx = { orgId: "org-1", projectId: "project-1", agentRunId: "run-1" };

function makeDeps(overrides: Partial<AgentMemoryToolDeps> = {}): AgentMemoryToolDeps & {
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ id: string; orgId: string; patch: Record<string, unknown> }>;
} {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; orgId: string; patch: Record<string, unknown> }> = [];
  return {
    inserts,
    updates,
    async insertMemory(values) {
      inserts.push(values as Record<string, unknown>);
      return { id: "mem-new" };
    },
    async updateMemory(id, orgId, patch) {
      updates.push({ id, orgId, patch: patch as Record<string, unknown> });
      return { id };
    },
    async listMemories() {
      return [];
    },
    ...overrides,
  };
}

test("agent memory tool params declare save, update, and list tools", () => {
  const names = agentMemoryToolParams.map((tool) => tool.name);
  assert.deepEqual(names, [
    SAVE_MEMORY_TOOL_NAME,
    UPDATE_MEMORY_TOOL_NAME,
    LIST_MEMORIES_TOOL_NAME,
  ]);
  for (const tool of agentMemoryToolParams) {
    assert.equal(tool.type, "custom");
    assert.equal(tool.input_schema.type, "object");
    assert.ok(tool.description.length > 0);
  }
  assert.ok(isAgentMemoryToolName(SAVE_MEMORY_TOOL_NAME));
  assert.ok(!isAgentMemoryToolName("revyl_run_test"));
});

test("save_memory inserts an org-wide memory by default", async () => {
  const deps = makeDeps();
  const result = await executeAgentMemoryTool(
    SAVE_MEMORY_TOOL_NAME,
    {
      kind: "terminology",
      title: "Sessions are called journeys",
      body: "This org calls user sessions journeys.",
    },
    ctx,
    deps,
  );

  assert.equal(result.isError, false);
  assert.deepEqual(result.payload, { ok: true, id: "mem-new" });
  assert.deepEqual(deps.inserts, [
    {
      orgId: "org-1",
      projectId: null,
      kind: "terminology",
      title: "Sessions are called journeys",
      body: "This org calls user sessions journeys.",
      sourceAgentRunId: "run-1",
    },
  ]);
});

test("save_memory scopes to the run's project when scope=project", async () => {
  const deps = makeDeps();
  const result = await executeAgentMemoryTool(
    SAVE_MEMORY_TOOL_NAME,
    { kind: "infra", title: "Checkout on ECS", body: "Checkout deploys to ECS.", scope: "project" },
    ctx,
    deps,
  );

  assert.equal(result.isError, false);
  assert.equal(deps.inserts[0]?.projectId, "project-1");
});

test("save_memory rejects an unknown kind", async () => {
  const deps = makeDeps();
  const result = await executeAgentMemoryTool(
    SAVE_MEMORY_TOOL_NAME,
    { kind: "gossip", title: "t", body: "b" },
    ctx,
    deps,
  );

  assert.equal(result.isError, true);
  assert.match(String((result.payload as { error: string }).error), /kind/);
  assert.equal(deps.inserts.length, 0);
});

test("save_memory rejects missing required fields", async () => {
  const deps = makeDeps();
  const result = await executeAgentMemoryTool(
    SAVE_MEMORY_TOOL_NAME,
    { kind: "infra", title: "no body" },
    ctx,
    deps,
  );

  assert.equal(result.isError, true);
  assert.match(String((result.payload as { error: string }).error), /body/);
});

test("update_memory patches fields and can archive", async () => {
  const deps = makeDeps();
  const result = await executeAgentMemoryTool(
    UPDATE_MEMORY_TOOL_NAME,
    { id: "mem-1", status: "archived" },
    ctx,
    deps,
  );

  assert.equal(result.isError, false);
  assert.deepEqual(result.payload, { ok: true, id: "mem-1" });
  assert.deepEqual(deps.updates, [{ id: "mem-1", orgId: "org-1", patch: { status: "archived" } }]);
});

test("update_memory requires at least one updatable field", async () => {
  const deps = makeDeps();
  const result = await executeAgentMemoryTool(UPDATE_MEMORY_TOOL_NAME, { id: "mem-1" }, ctx, deps);

  assert.equal(result.isError, true);
  assert.equal(deps.updates.length, 0);
});

test("update_memory reports unknown ids as errors", async () => {
  const deps = makeDeps({
    async updateMemory() {
      return null;
    },
  });
  const result = await executeAgentMemoryTool(
    UPDATE_MEMORY_TOOL_NAME,
    { id: "missing", body: "new" },
    ctx,
    deps,
  );

  assert.equal(result.isError, true);
  assert.match(String((result.payload as { error: string }).error), /not found/);
});

test("list_memories returns memories with scope labels", async () => {
  const deps = makeDeps({
    async listMemories(orgId, projectId) {
      assert.equal(orgId, "org-1");
      assert.equal(projectId, "project-1");
      return [
        { id: "m1", kind: "terminology", title: "t1", body: "b1", projectId: null },
        { id: "m2", kind: "infra", title: "t2", body: "b2", projectId: "project-1" },
      ] as schema.AgentMemory[];
    },
  });
  const result = await executeAgentMemoryTool(LIST_MEMORIES_TOOL_NAME, {}, ctx, deps);

  assert.equal(result.isError, false);
  assert.deepEqual(result.payload, {
    memories: [
      { id: "m1", kind: "terminology", scope: "org", title: "t1", body: "b1" },
      { id: "m2", kind: "infra", scope: "project", title: "t2", body: "b2" },
    ],
  });
});

test("executeAgentMemoryTool rejects unknown tool names", async () => {
  const result = await executeAgentMemoryTool("not_a_memory_tool", {}, ctx, makeDeps());
  assert.equal(result.isError, true);
});
