import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const {
  parseMemoryKind,
  parseMemoryText,
  parseMemoryStatus,
  serializeAgentMemory,
  createAgentMemory,
  AGENT_MEMORY_TITLE_MAX_LEN,
  AGENT_MEMORY_BODY_MAX_LEN,
} = await import("./agent-memories-service.js");

test("parseMemoryKind accepts the four valid kinds and rejects others", () => {
  for (const kind of ["feedback", "terminology", "infra", "project"]) {
    assert.equal(parseMemoryKind(kind), kind);
  }
  assert.equal(parseMemoryKind("bogus"), null);
  assert.equal(parseMemoryKind(42), null);
  assert.equal(parseMemoryKind(undefined), null);
});

test("parseMemoryText trims, rejects empty, and clamps to maxLen", () => {
  assert.equal(parseMemoryText("  hello  ", 100), "hello");
  assert.equal(parseMemoryText("   ", 100), null);
  assert.equal(parseMemoryText(123, 100), null);
  assert.equal(parseMemoryText("x".repeat(50), 10)?.length, 10);
});

test("title/body max lengths are exported for the MCP schema", () => {
  assert.equal(AGENT_MEMORY_TITLE_MAX_LEN, 200);
  assert.equal(AGENT_MEMORY_BODY_MAX_LEN, 4000);
});

test("parseMemoryStatus only accepts active/archived", () => {
  assert.equal(parseMemoryStatus("active"), "active");
  assert.equal(parseMemoryStatus("archived"), "archived");
  assert.equal(parseMemoryStatus("deleted"), null);
  assert.equal(parseMemoryStatus(undefined), null);
});

test("createAgentMemory rejects an unattributed or doubly-attributed create", async () => {
  const base = { orgId: "o1", projectId: "p1", kind: "project" as const, title: "t", body: "b" };
  // The guard throws before any DB access, so these never open a connection.
  await assert.rejects(
    () => createAgentMemory(base),
    /exactly one of sourceUserId or sourceAgentRunId/,
  );
  await assert.rejects(
    () => createAgentMemory({ ...base, sourceUserId: "u1", sourceAgentRunId: "r1" }),
    /exactly one of sourceUserId or sourceAgentRunId/,
  );
});

test("serializeAgentMemory derives source from which provenance column is set", () => {
  const base = {
    id: "m1",
    orgId: "o1",
    projectId: "p1",
    kind: "infra" as const,
    title: "Checkout runs on ECS",
    body: "...",
    status: "active" as const,
    sourceAgentRunId: null,
    sourceUserId: null,
    lastUsedAt: null,
    createdAt: new Date("2026-06-27T00:00:00.000Z"),
    updatedAt: new Date("2026-06-27T00:00:00.000Z"),
  };

  assert.equal(serializeAgentMemory({ ...base, sourceAgentRunId: "run1" }).source, "agent");
  assert.equal(serializeAgentMemory({ ...base, sourceUserId: "user1" }).source, "user");
  assert.equal(serializeAgentMemory(base).source, null);

  const out = serializeAgentMemory(base);
  assert.deepEqual(out, {
    id: "m1",
    kind: "infra",
    projectId: "p1",
    title: "Checkout runs on ECS",
    body: "...",
    status: "active",
    source: null,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  });
});
