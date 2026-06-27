import type { ClickHouseClient } from "@clickhouse/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  AGENT_MEMORY_BODY_MAX_LEN,
  AGENT_MEMORY_TITLE_MAX_LEN,
  createAgentMemory,
  deleteAgentMemory,
  listAgentMemories,
  parseMemoryText,
  serializeAgentMemory,
  updateAgentMemory,
} from "../agent-memories-service.js";
import {
  getIssueFilterConfig,
  mergeIssueFilterConfig,
  sanitizeIssueFilterConfig,
  setIssueFilterConfig,
} from "../issue-filter-service.js";
import { getProjectContext, setProjectContext } from "../project-context-service.js";
import { previewIssueFilterMatches } from "./clickhouse.js";

const projectIdSchema = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Project to operate on. Defaults to the session's active project. Use list_projects to discover ids.",
  );

const clauseSchema = z.object({
  key: z.string().min(1).max(200).describe("Attribute key, e.g. 'service.name' or 'http.route'"),
  value: z.string().min(1).max(400).describe("Exact value the attribute must equal"),
});
const clauseListSchema = z.array(clauseSchema).max(20);

// Picker/preview population matches the REST editor: ERROR events in the last
// 24h, the window the worker filter actually applies to.
const ISSUE_FILTER_RANGE = "now() - INTERVAL 24 HOUR";

const memoryKindSchema = z
  .enum(["feedback", "terminology", "infra", "project"])
  .describe(
    "feedback = a correction/preference for how the agent should work; terminology = a domain term/acronym; infra = how the system is deployed/runs; project = general project facts.",
  );

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

type Session = {
  userId: string;
  activeProjectId: string;
  allowedOrgId?: string;
};

export function registerAgentConfigTools(
  server: McpServer,
  session: Session,
  ch: ClickHouseClient,
): void {
  // Resolve a project id, enforcing both the token's org scope (if any) and the
  // user's org membership, and return the owning org so memory rows are stamped
  // correctly.
  const resolve = async (
    explicit: string | undefined,
  ): Promise<{ projectId: string; orgId: string }> => {
    const projectId = explicit ?? session.activeProjectId;
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, projectId),
      columns: { id: true, orgId: true },
    });
    if (!project) throw new HTTPException(404, { message: "project not found" });
    if (session.allowedOrgId && project.orgId !== session.allowedOrgId) {
      throw new HTTPException(403, { message: "project is outside this MCP token's org scope" });
    }
    const membership = await db.query.orgMembers.findFirst({
      where: and(
        eq(schema.orgMembers.userId, session.userId),
        eq(schema.orgMembers.orgId, project.orgId),
      ),
    });
    if (!membership) throw new HTTPException(403, { message: "no access to project" });
    return { projectId: project.id, orgId: project.orgId };
  };

  // ---- Issue filter ----------------------------------------------------

  server.registerTool(
    "get_issue_filter",
    {
      title: "Get issue filter",
      description:
        "Read the project's issue filter: per-kind include/exclude attribute clauses that decide which ERROR events become issues/incidents. Excludes win; a non-empty include list means an event must match at least one clause.",
      inputSchema: { project_id: projectIdSchema },
    },
    async (input) => {
      const { projectId } = await resolve(input.project_id);
      return text(await getIssueFilterConfig(projectId));
    },
  );

  server.registerTool(
    "update_issue_filter",
    {
      title: "Update issue filter",
      description:
        "Update the issue filter. Each bucket you provide REPLACES that bucket; omit a bucket to leave it unchanged; pass [] to clear it. Use this to quiet recurring noise (add an exclude clause) or to scope investigations to specific services/routes (add an include clause). Call get_issue_filter first if you want to add to the existing rules rather than overwrite them.",
      inputSchema: {
        project_id: projectIdSchema,
        includeLogs: clauseListSchema
          .optional()
          .describe("Logs must match ≥1 of these (if non-empty) to become an issue."),
        includeSpans: clauseListSchema
          .optional()
          .describe("Spans must match ≥1 of these (if non-empty) to become an issue."),
        excludeLogs: clauseListSchema
          .optional()
          .describe("Logs matching ANY of these are dropped (never become issues)."),
        excludeSpans: clauseListSchema
          .optional()
          .describe("Spans matching ANY of these are dropped (never become issues)."),
      },
    },
    async (input) => {
      const { projectId } = await resolve(input.project_id);
      const current = await getIssueFilterConfig(projectId);
      const next = mergeIssueFilterConfig(current, {
        includeLogs: input.includeLogs,
        includeSpans: input.includeSpans,
        excludeLogs: input.excludeLogs,
        excludeSpans: input.excludeSpans,
      });
      return text(await setIssueFilterConfig(projectId, next));
    },
  );

  server.registerTool(
    "preview_issue_filter",
    {
      title: "Preview issue filter",
      description:
        "Preview which recent ERROR events (last 24h) would still become issues under a candidate filter, WITHOUT saving. Buckets you pass are merged over the project's current filter (same semantics as update_issue_filter); omit all buckets to preview the current saved filter. Returns sample matching events.",
      inputSchema: {
        project_id: projectIdSchema,
        includeLogs: clauseListSchema.optional(),
        includeSpans: clauseListSchema.optional(),
        excludeLogs: clauseListSchema.optional(),
        excludeSpans: clauseListSchema.optional(),
      },
    },
    async (input) => {
      const { projectId } = await resolve(input.project_id);
      const current = await getIssueFilterConfig(projectId);
      const config = sanitizeIssueFilterConfig(
        mergeIssueFilterConfig(current, {
          includeLogs: input.includeLogs,
          includeSpans: input.includeSpans,
          excludeLogs: input.excludeLogs,
          excludeSpans: input.excludeSpans,
        }),
        current,
      );
      const events = await previewIssueFilterMatches(
        ch,
        projectId,
        config,
        { since: ISSUE_FILTER_RANGE },
        10,
      );
      return text({ config, events });
    },
  );

  // ---- Project context -------------------------------------------------

  server.registerTool(
    "get_project_context",
    {
      title: "Get project context",
      description:
        "Read the project's freeform context — the human-written description of the system (architecture, conventions, key services) that the investigation agent reads on every run.",
      inputSchema: { project_id: projectIdSchema },
    },
    async (input) => {
      const { projectId } = await resolve(input.project_id);
      return text({ projectContext: await getProjectContext(projectId) });
    },
  );

  server.registerTool(
    "set_project_context",
    {
      title: "Set project context",
      description:
        "Overwrite the project's freeform context (max 8000 chars; longer input is truncated). This REPLACES the whole field — call get_project_context first and edit the returned text if you want to preserve existing content. Use for durable, system-level facts that apply to every investigation; for narrower learnings prefer create_agent_memory.",
      inputSchema: {
        project_id: projectIdSchema,
        context: z
          .string()
          .max(20000)
          .describe("The full context text. Replaces the existing value."),
      },
    },
    async (input) => {
      const { projectId } = await resolve(input.project_id);
      return text({ projectContext: await setProjectContext(projectId, input.context) });
    },
  );

  // ---- Agent memories --------------------------------------------------

  server.registerTool(
    "list_agent_memories",
    {
      title: "List agent memories",
      description:
        "List the investigation agent's stored memories for the project — durable learnings (feedback, terminology, infra, project facts) that are injected into future investigations.",
      inputSchema: { project_id: projectIdSchema },
    },
    async (input) => {
      const { projectId, orgId } = await resolve(input.project_id);
      const rows = await listAgentMemories(orgId, projectId);
      return text({ memories: rows.map(serializeAgentMemory) });
    },
  );

  server.registerTool(
    "create_agent_memory",
    {
      title: "Create agent memory",
      description:
        "Record a durable, reusable learning so future investigations inherit it. Record a memory whenever you discover something worth remembering across investigations — a root-cause pattern, a piece of infra/architecture, a domain term, or a user correction about how to investigate. Keep the title a short handle and the body the specific, reusable fact (not a one-off incident narrative).",
      inputSchema: {
        project_id: projectIdSchema,
        kind: memoryKindSchema,
        title: z
          .string()
          .min(1)
          .max(AGENT_MEMORY_TITLE_MAX_LEN)
          .describe("Short handle for the memory."),
        body: z
          .string()
          .min(1)
          .max(AGENT_MEMORY_BODY_MAX_LEN)
          .describe("The specific, reusable fact or instruction."),
      },
    },
    async (input) => {
      const { projectId, orgId } = await resolve(input.project_id);
      const title = parseMemoryText(input.title, AGENT_MEMORY_TITLE_MAX_LEN);
      const body = parseMemoryText(input.body, AGENT_MEMORY_BODY_MAX_LEN);
      if (!title) throw new HTTPException(400, { message: "title is required" });
      if (!body) throw new HTTPException(400, { message: "body is required" });
      const row = await createAgentMemory({
        orgId,
        projectId,
        kind: input.kind,
        title,
        body,
        sourceUserId: session.userId,
      });
      if (!row) throw new HTTPException(500, { message: "failed to create memory" });
      return text({ memory: serializeAgentMemory(row) });
    },
  );

  server.registerTool(
    "update_agent_memory",
    {
      title: "Update agent memory",
      description:
        "Patch a stored memory. Provide only the fields you want to change. Set status='archived' to retire a memory without deleting it (archived memories stop being injected into investigations).",
      inputSchema: {
        project_id: projectIdSchema,
        id: z.string().uuid().describe("Memory id from list_agent_memories"),
        kind: memoryKindSchema.optional(),
        title: z.string().min(1).max(AGENT_MEMORY_TITLE_MAX_LEN).optional(),
        body: z.string().min(1).max(AGENT_MEMORY_BODY_MAX_LEN).optional(),
        status: z.enum(["active", "archived"]).optional(),
      },
    },
    async (input) => {
      const { projectId, orgId } = await resolve(input.project_id);
      const patch: {
        kind?: typeof input.kind;
        title?: string;
        body?: string;
        status?: "active" | "archived";
      } = {};
      if (input.kind !== undefined) patch.kind = input.kind;
      if (input.title !== undefined) {
        const title = parseMemoryText(input.title, AGENT_MEMORY_TITLE_MAX_LEN);
        if (!title) throw new HTTPException(400, { message: "title must be a non-empty string" });
        patch.title = title;
      }
      if (input.body !== undefined) {
        const body = parseMemoryText(input.body, AGENT_MEMORY_BODY_MAX_LEN);
        if (!body) throw new HTTPException(400, { message: "body must be a non-empty string" });
        patch.body = body;
      }
      if (input.status !== undefined) patch.status = input.status;
      if (Object.keys(patch).length === 0) {
        throw new HTTPException(400, {
          message: "provide at least one of kind, title, body, status",
        });
      }
      const row = await updateAgentMemory(orgId, projectId, input.id, patch);
      if (!row) throw new HTTPException(404, { message: "memory not found" });
      return text({ memory: serializeAgentMemory(row) });
    },
  );

  server.registerTool(
    "delete_agent_memory",
    {
      title: "Delete agent memory",
      description:
        "Permanently delete a stored memory by id. To retire one reversibly, prefer update_agent_memory with status='archived'.",
      inputSchema: {
        project_id: projectIdSchema,
        id: z.string().uuid().describe("Memory id from list_agent_memories"),
      },
    },
    async (input) => {
      const { projectId, orgId } = await resolve(input.project_id);
      const ok = await deleteAgentMemory(orgId, projectId, input.id);
      if (!ok) throw new HTTPException(404, { message: "memory not found" });
      return text({ ok: true });
    },
  );
}
