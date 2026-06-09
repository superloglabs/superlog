// Custom tools that let the investigation agent persist durable facts across
// runs (terminology, infra/project structure, lessons from feedback). The
// runner backend declares these on the agent and dispatches calls back here.
import { type NewAgentMemory, db, schema } from "@superlog/db";
import { and, asc, eq, isNull, or } from "drizzle-orm";

export const SAVE_MEMORY_TOOL_NAME = "save_memory";
export const UPDATE_MEMORY_TOOL_NAME = "update_memory";
export const LIST_MEMORIES_TOOL_NAME = "list_memories";

const MEMORY_KINDS: schema.AgentMemoryKind[] = ["feedback", "terminology", "infra", "project"];
const MEMORY_STATUSES: schema.AgentMemoryStatus[] = ["active", "archived"];
const TITLE_MAX_CHARS = 200;
const BODY_MAX_CHARS = 4_000;

export type AgentMemoryToolParam = {
  type: "custom";
  name: string;
  description: string;
  input_schema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
};

export const agentMemoryToolParams: AgentMemoryToolParam[] = [
  {
    type: "custom",
    name: SAVE_MEMORY_TOOL_NAME,
    description:
      "Save a durable fact for future investigations: org terminology, infra/project structure, or a lesson from human feedback. " +
      "Save when a human corrects you or teaches you something, and when you learn a stable fact the hard way (which repo owns a service, what an org-specific term means, how the infra is laid out). " +
      "Keep memories short, general, and self-contained — they are injected into every future run's prompt. Do not save incident-specific findings, secrets, or anything already in the memories list.",
    input_schema: {
      type: "object",
      required: ["kind", "title", "body"],
      properties: {
        kind: {
          type: "string",
          enum: MEMORY_KINDS,
          description:
            "feedback = lesson from human feedback/corrections; terminology = org-specific naming; infra = deployment/infrastructure facts; project = codebase/project structure facts.",
        },
        title: { type: "string", description: "Short one-line summary (max 200 chars)." },
        body: {
          type: "string",
          description: "The fact itself, 1-4 sentences, self-contained (max 4000 chars).",
        },
        scope: {
          type: "string",
          enum: ["org", "project"],
          description:
            "org (default) = visible to investigations in every project; project = only investigations in the current project.",
        },
      },
    },
  },
  {
    type: "custom",
    name: UPDATE_MEMORY_TOOL_NAME,
    description:
      "Update or archive an existing memory by id (ids come from the memories list in your prompt or from list_memories). " +
      "Use this instead of save_memory when a fact changed or turned out to be wrong — set status=archived to retire it.",
    input_schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The memory id to update." },
        kind: { type: "string", enum: MEMORY_KINDS },
        title: { type: "string" },
        body: { type: "string" },
        status: {
          type: "string",
          enum: MEMORY_STATUSES,
          description: "Set archived to retire a wrong or stale memory.",
        },
      },
    },
  },
  {
    type: "custom",
    name: LIST_MEMORIES_TOOL_NAME,
    description:
      "List the active memories visible to this investigation (org-wide plus current-project). " +
      "Call before save_memory if you are unsure whether a fact is already recorded.",
    input_schema: { type: "object", properties: {} },
  },
];

const MEMORY_TOOL_NAMES = new Set(agentMemoryToolParams.map((tool) => tool.name));

export function isAgentMemoryToolName(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

export type AgentMemoryToolContext = {
  orgId: string;
  projectId: string;
  agentRunId: string | null;
};

// Dispatchers only carry { sessionId, orgId, incidentId }; memory writes also
// need the project scope and run provenance. Resolves both from the incident
// row and the run's provider session id.
export async function resolveAgentMemoryToolContext(args: {
  orgId: string;
  incidentId: string;
  sessionId: string;
}): Promise<AgentMemoryToolContext | null> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, args.incidentId),
    columns: { projectId: true },
  });
  if (!incident) return null;
  const run = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.providerSessionId, args.sessionId),
    columns: { id: true },
  });
  return { orgId: args.orgId, projectId: incident.projectId, agentRunId: run?.id ?? null };
}

export type AgentMemoryToolDeps = {
  insertMemory(values: NewAgentMemory): Promise<{ id: string }>;
  updateMemory(
    id: string,
    orgId: string,
    patch: Partial<Pick<schema.AgentMemory, "kind" | "title" | "body" | "status">>,
  ): Promise<{ id: string } | null>;
  listMemories(orgId: string, projectId: string): Promise<schema.AgentMemory[]>;
};

// Active memories visible to a run: org-wide rows (project_id null) plus rows
// scoped to the given project. Oldest first so prompts read in the order the
// knowledge was learned.
export async function listActiveAgentMemories(
  orgId: string,
  projectId: string,
): Promise<schema.AgentMemory[]> {
  return db.query.agentMemories.findMany({
    where: and(
      eq(schema.agentMemories.orgId, orgId),
      eq(schema.agentMemories.status, "active"),
      or(isNull(schema.agentMemories.projectId), eq(schema.agentMemories.projectId, projectId)),
    ),
    orderBy: [asc(schema.agentMemories.createdAt)],
  });
}

const defaultDeps: AgentMemoryToolDeps = {
  async insertMemory(values) {
    const [row] = await db
      .insert(schema.agentMemories)
      .values(values)
      .returning({ id: schema.agentMemories.id });
    if (!row) throw new Error("failed to insert agent memory");
    return row;
  },
  async updateMemory(id, orgId, patch) {
    const [row] = await db
      .update(schema.agentMemories)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(schema.agentMemories.id, id), eq(schema.agentMemories.orgId, orgId)))
      .returning({ id: schema.agentMemories.id });
    return row ?? null;
  },
  listMemories: listActiveAgentMemories,
};

export type AgentMemoryToolResult = { payload: unknown; isError: boolean };

export async function executeAgentMemoryTool(
  name: string,
  input: unknown,
  ctx: AgentMemoryToolContext,
  deps: AgentMemoryToolDeps = defaultDeps,
): Promise<AgentMemoryToolResult> {
  try {
    if (name === SAVE_MEMORY_TOOL_NAME) return await saveMemory(input, ctx, deps);
    if (name === UPDATE_MEMORY_TOOL_NAME) return await updateMemory(input, ctx, deps);
    if (name === LIST_MEMORIES_TOOL_NAME) return await listMemories(ctx, deps);
    return error(`unknown memory tool: ${name}`);
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
}

async function saveMemory(
  input: unknown,
  ctx: AgentMemoryToolContext,
  deps: AgentMemoryToolDeps,
): Promise<AgentMemoryToolResult> {
  const record = asRecord(input);
  if (!record) return error("input must be an object");
  const kind = parseEnum(record.kind, MEMORY_KINDS, "kind");
  if (typeof kind !== "string") return kind;
  const title = parseText(record.title, "title", TITLE_MAX_CHARS);
  if (typeof title !== "string") return title;
  const body = parseText(record.body, "body", BODY_MAX_CHARS);
  if (typeof body !== "string") return body;
  const scope =
    record.scope === undefined ? "org" : parseEnum(record.scope, ["org", "project"], "scope");
  if (typeof scope !== "string") return scope;

  const inserted = await deps.insertMemory({
    orgId: ctx.orgId,
    projectId: scope === "project" ? ctx.projectId : null,
    kind,
    title,
    body,
    sourceAgentRunId: ctx.agentRunId,
  });
  return { payload: { ok: true, id: inserted.id }, isError: false };
}

async function updateMemory(
  input: unknown,
  ctx: AgentMemoryToolContext,
  deps: AgentMemoryToolDeps,
): Promise<AgentMemoryToolResult> {
  const record = asRecord(input);
  if (!record) return error("input must be an object");
  if (typeof record.id !== "string" || record.id.length === 0) {
    return error("missing required field: id");
  }

  const patch: Partial<Pick<schema.AgentMemory, "kind" | "title" | "body" | "status">> = {};
  if (record.kind !== undefined) {
    const kind = parseEnum(record.kind, MEMORY_KINDS, "kind");
    if (typeof kind !== "string") return kind;
    patch.kind = kind;
  }
  if (record.title !== undefined) {
    const title = parseText(record.title, "title", TITLE_MAX_CHARS);
    if (typeof title !== "string") return title;
    patch.title = title;
  }
  if (record.body !== undefined) {
    const body = parseText(record.body, "body", BODY_MAX_CHARS);
    if (typeof body !== "string") return body;
    patch.body = body;
  }
  if (record.status !== undefined) {
    const status = parseEnum(record.status, MEMORY_STATUSES, "status");
    if (typeof status !== "string") return status;
    patch.status = status;
  }
  if (Object.keys(patch).length === 0) {
    return error("provide at least one of kind, title, body, status");
  }

  const updated = await deps.updateMemory(record.id, ctx.orgId, patch);
  if (!updated) return error(`memory not found: ${record.id}`);
  return { payload: { ok: true, id: updated.id }, isError: false };
}

async function listMemories(
  ctx: AgentMemoryToolContext,
  deps: AgentMemoryToolDeps,
): Promise<AgentMemoryToolResult> {
  const memories = await deps.listMemories(ctx.orgId, ctx.projectId);
  return {
    payload: {
      memories: memories.map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        scope: memory.projectId ? "project" : "org",
        title: memory.title,
        body: memory.body,
      })),
    },
    isError: false,
  };
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function parseText(
  value: unknown,
  field: string,
  maxChars: number,
): string | AgentMemoryToolResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return error(`missing required field: ${field}`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    return error(`field ${field} exceeds ${maxChars} characters`);
  }
  return trimmed;
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | AgentMemoryToolResult {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    return error(`field ${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function error(message: string): AgentMemoryToolResult {
  return { payload: { error: message }, isError: true };
}
