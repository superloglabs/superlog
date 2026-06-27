import { db, schema } from "@superlog/db";
import { and, asc, eq } from "drizzle-orm";

export const AGENT_MEMORY_TITLE_MAX_LEN = 200;
export const AGENT_MEMORY_BODY_MAX_LEN = 4000;

export const AGENT_MEMORY_KINDS: schema.AgentMemoryKind[] = [
  "feedback",
  "terminology",
  "infra",
  "project",
];

export type AgentMemoryStatus = "active" | "archived";

export function parseMemoryKind(value: unknown): schema.AgentMemoryKind | null {
  return typeof value === "string" && (AGENT_MEMORY_KINDS as string[]).includes(value)
    ? (value as schema.AgentMemoryKind)
    : null;
}

export function parseMemoryText(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLen);
}

export function parseMemoryStatus(value: unknown): AgentMemoryStatus | null {
  return value === "active" || value === "archived" ? value : null;
}

export function serializeAgentMemory(row: schema.AgentMemory) {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    status: row.status,
    source: row.sourceAgentRunId ? "agent" : row.sourceUserId ? "user" : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function listAgentMemories(orgId: string, projectId: string) {
  return db.query.agentMemories.findMany({
    where: and(
      eq(schema.agentMemories.orgId, orgId),
      eq(schema.agentMemories.projectId, projectId),
    ),
    orderBy: [asc(schema.agentMemories.createdAt)],
  });
}

export type CreateAgentMemoryInput = {
  orgId: string;
  projectId: string;
  kind: schema.AgentMemoryKind;
  title: string;
  body: string;
  /**
   * Provenance: pass exactly one. user-authored memories set sourceUserId,
   * agent-authored ones set sourceAgentRunId. (The schema also permits both
   * null for system backfills, but those don't go through this helper — it's
   * for attributed creates, so we reject an unattributed call here.)
   */
  sourceUserId?: string;
  sourceAgentRunId?: string;
};

export async function createAgentMemory(
  input: CreateAgentMemoryInput,
): Promise<schema.AgentMemory | null> {
  if (!!input.sourceUserId === !!input.sourceAgentRunId) {
    throw new Error("createAgentMemory requires exactly one of sourceUserId or sourceAgentRunId");
  }
  const [row] = await db
    .insert(schema.agentMemories)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      sourceUserId: input.sourceUserId,
      sourceAgentRunId: input.sourceAgentRunId,
    })
    .returning();
  return row ?? null;
}

export type AgentMemoryPatch = {
  kind?: schema.AgentMemoryKind;
  title?: string;
  body?: string;
  status?: AgentMemoryStatus;
};

export async function updateAgentMemory(
  orgId: string,
  projectId: string,
  id: string,
  patch: AgentMemoryPatch,
): Promise<schema.AgentMemory | null> {
  const [row] = await db
    .update(schema.agentMemories)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentMemories.id, id),
        eq(schema.agentMemories.orgId, orgId),
        eq(schema.agentMemories.projectId, projectId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteAgentMemory(
  orgId: string,
  projectId: string,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .delete(schema.agentMemories)
    .where(
      and(
        eq(schema.agentMemories.id, id),
        eq(schema.agentMemories.orgId, orgId),
        eq(schema.agentMemories.projectId, projectId),
      ),
    )
    .returning({ id: schema.agentMemories.id });
  return !!row;
}
