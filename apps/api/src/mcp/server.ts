import type { ClickHouseClient } from "@clickhouse/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { registerAgentConfigTools } from "./agent-config.js";
import { registerAlertTools } from "./alerts.js";
import { instrumentMcpToolAnalytics } from "./analytics.js";
import { listServices, queryLogs, queryMetrics, queryTraces } from "./clickhouse.js";
import { registerDashboardTools } from "./dashboards.js";
import { registerIncidentTools } from "./incidents.js";
import {
  assertProjectAccess,
  listAccessibleProjects,
  setActiveProjectForToken,
} from "./projects.js";

const timeRangeSchema = z
  .object({
    since: z
      .string()
      .describe(
        "ISO-8601 timestamp or ClickHouse time expression (e.g. 'now() - INTERVAL 1 HOUR'). Defaults to 1 hour ago.",
      )
      .optional(),
    until: z
      .string()
      .describe("ISO-8601 timestamp or ClickHouse time expression. Defaults to 'now()'.")
      .optional(),
  })
  .optional();

const resourceAttrsSchema = z
  .array(
    z.object({
      key: z.string(),
      value: z.string(),
      op: z.enum(["eq", "neq", "not_contains"]).optional(),
    }),
  )
  .optional()
  .describe(
    "Filters on OTel resource attributes, e.g. [{key:'deployment.environment', value:'prod'}]. Optional op supports eq, neq, and not_contains.",
  );

const spanAttrsSchema = z
  .array(z.object({ key: z.string(), value: z.string() }))
  .optional()
  .describe(
    "Equality filters on per-span attributes (SpanAttributes), e.g. [{key:'http.response.status_code', value:'410'}] or [{key:'http.route', value:'/api/signup-intents/:id/claim'}]. Use this when you need to filter spans by HTTP status code, route template, method, db statement, etc. — those live in SpanAttributes, not the span's StatusCode (which only encodes the OTel-level OK/ERROR/UNSET).",
  );

const logAttrsSchema = z
  .array(z.object({ key: z.string(), value: z.string() }))
  .optional()
  .describe(
    "Equality filters on per-log-record attributes (LogAttributes), e.g. [{key:'event.name', value:'auth.failure'}]. Distinct from resource_attrs (which apply to the emitting service) and from Body substring search.",
  );

const projectIdSchema = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Project to query. Defaults to the session's active project. Use list_projects to discover ids and set_active_project to switch the default.",
  );

export type McpSession = {
  ch: ClickHouseClient;
  userId: string;
  tokenId: string;
  /** Which token table backs this session — set_active_project writes there. */
  tokenKind: "oauth" | "pat";
  /** Mutable: updated by set_active_project so subsequent calls see the new default. */
  activeProjectId: string;
  allowedOrgId?: string;
  telemetryOnly?: boolean;
};

// Advisory guidance surfaced to compatible MCP clients in the initialize
// response. It's a nudge, not a guarantee — the connecting agent decides
// whether to act on it — but most first-party clients inject it into context,
// so it's where we steer the agent toward recording durable learnings.
const SERVER_INSTRUCTIONS = [
  "Superlog is an observability + investigation platform. Beyond querying telemetry (logs/traces/metrics) and incidents, you can tune how this project investigates issues.",
  "",
  "Record memories as you learn. When you uncover something that would help future investigations — a root-cause pattern, an infra/architecture fact, a domain term, or a correction about how to investigate — call create_agent_memory so it's injected into later runs. Prefer a short title + a specific, reusable body over a one-off incident narrative. Check list_agent_memories first to avoid duplicates, and update_agent_memory (status='archived') to retire stale ones.",
  "",
  "Capture system-level facts in the project context. For durable facts that apply to every investigation (architecture, conventions, key services), read get_project_context and append via set_project_context (it replaces the whole field, so edit the returned text).",
  "",
  "Tune the issue filter to control noise. When the user describes recurring noise or wants investigations scoped to certain services/routes, use get_issue_filter / preview_issue_filter / update_issue_filter — excludes drop matching events, non-empty includes restrict to matching events. Always preview before saving.",
].join("\n");

export function createMcpServerForSession(session: McpSession): McpServer {
  // Telemetry-only sessions don't get the agent-config / alert / dashboard /
  // incident tools, so the guidance below (which is all about them) would
  // advertise tools that aren't registered. Omit instructions in that case.
  const server = new McpServer(
    { name: "superlog", version: "0.1.0" },
    session.telemetryOnly ? undefined : { instructions: SERVER_INSTRUCTIONS },
  );

  // Before any registerTool call so every tool below (and in the register*
  // modules) emits a per-invocation analytics event.
  instrumentMcpToolAnalytics(server, session);

  const assertTokenScope = async (projectId: string): Promise<void> => {
    if (!session.allowedOrgId) return;
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, projectId),
    });
    if (!project || project.orgId !== session.allowedOrgId) {
      throw new Error("project is outside this MCP token's org scope");
    }
  };

  const resolveProject = async (explicit: string | undefined): Promise<string> => {
    const id = explicit ?? session.activeProjectId;
    await assertTokenScope(id);
    await assertProjectAccess(session.userId, id);
    return id;
  };

  server.registerTool(
    "query_logs",
    {
      title: "Query logs",
      description:
        "Search OpenTelemetry logs. Targets the session's active project unless project_id is given. Error rows include flattened exception_type, exception_message, and exception_stacktrace fields when present.",
      inputSchema: {
        project_id: projectIdSchema,
        range: timeRangeSchema,
        service: z.string().optional().describe("Filter by service.name"),
        severity: z
          .string()
          .optional()
          .describe("Filter by severity text (e.g. 'ERROR', 'WARN', 'INFO')"),
        search: z.string().optional().describe("Case-insensitive substring match on log body"),
        resource_attrs: resourceAttrsSchema,
        log_attrs: logAttrsSchema,
        limit: z.number().int().positive().max(500).default(50),
      },
    },
    async (input) => {
      const projectId = await resolveProject(input.project_id);
      const rows = await queryLogs(session.ch, projectId, {
        range: input.range,
        service: input.service,
        severity: input.severity,
        search: input.search,
        resourceAttrs: input.resource_attrs,
        logAttrs: input.log_attrs,
        limit: input.limit,
      });
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  );

  server.registerTool(
    "query_traces",
    {
      title: "Query traces",
      description:
        "Search OpenTelemetry spans. Targets the session's active project unless project_id is given. Spans with exception events include flattened exception_type, exception_message, and exception_stacktrace fields when present.",
      inputSchema: {
        project_id: projectIdSchema,
        range: timeRangeSchema,
        service: z.string().optional(),
        span_name: z.string().optional(),
        status_code: z
          .enum(["STATUS_CODE_OK", "STATUS_CODE_ERROR", "STATUS_CODE_UNSET"])
          .optional()
          .describe(
            "OTel span status (not HTTP status). By the OTel HTTP semconv, only 5xx server responses auto-set ERROR — 4xx (including 410) stays UNSET. To find spans by HTTP status code, use span_attrs with key 'http.response.status_code'.",
          ),
        min_duration_ms: z.number().nonnegative().optional(),
        resource_attrs: resourceAttrsSchema,
        span_attrs: spanAttrsSchema,
        limit: z.number().int().positive().max(500).default(50),
      },
    },
    async (input) => {
      const projectId = await resolveProject(input.project_id);
      const rows = await queryTraces(session.ch, projectId, {
        range: input.range,
        service: input.service,
        spanName: input.span_name,
        statusCode: input.status_code,
        minDurationMs: input.min_duration_ms,
        resourceAttrs: input.resource_attrs,
        spanAttrs: input.span_attrs,
        limit: input.limit,
      });
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  );

  server.registerTool(
    "query_metrics",
    {
      title: "Query metrics",
      description:
        "Fetch recent metric points across gauge, sum, explicit-histogram, exponential-histogram, and summary tables. Targets the session's active project unless project_id is given. Each point includes its data-point `attributes` (the per-series dimensions like route/status/tenant), `resource_attrs`, start time, and aggregation temporality where applicable. Gauge/sum points carry a scalar `value`; histogram/summary points carry `count` and `sum` (plus `min`/`max` for histograms) instead, since they have no scalar value.",
      inputSchema: {
        project_id: projectIdSchema,
        metric_name: z.string().optional(),
        service: z.string().optional(),
        range: timeRangeSchema,
        resource_attrs: resourceAttrsSchema,
        limit: z.number().int().positive().max(500).default(100),
      },
    },
    async (input) => {
      const projectId = await resolveProject(input.project_id);
      const rows = await queryMetrics(session.ch, projectId, {
        metricName: input.metric_name,
        service: input.service,
        range: input.range,
        resourceAttrs: input.resource_attrs,
        limit: input.limit,
      });
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description: "List distinct service.name values emitting telemetry in the given window.",
      inputSchema: {
        project_id: projectIdSchema,
        range: timeRangeSchema,
      },
    },
    async (input) => {
      const projectId = await resolveProject(input.project_id);
      const services = await listServices(session.ch, projectId, input.range);
      return { content: [{ type: "text", text: JSON.stringify(services) }] };
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List every project the authenticated user can access, across all of their orgs. The active project is marked.",
      inputSchema: {},
    },
    async () => {
      const projects = (await listAccessibleProjects(session.userId)).filter(
        (p) => !session.allowedOrgId || p.orgId === session.allowedOrgId,
      );
      const payload = projects.map((p) => ({
        ...p,
        active: p.id === session.activeProjectId,
      }));
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  );

  server.registerTool(
    "get_active_project",
    {
      title: "Get active project",
      description: "Return the project that tools default to when project_id is omitted.",
      inputSchema: {},
    },
    async () => {
      const projects = (await listAccessibleProjects(session.userId)).filter(
        (p) => !session.allowedOrgId || p.orgId === session.allowedOrgId,
      );
      const active = projects.find((p) => p.id === session.activeProjectId) ?? null;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(active ?? { id: session.activeProjectId }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "set_active_project",
    {
      title: "Set active project",
      description:
        "Change the default project for subsequent tool calls in this session. Persists for the lifetime of the access token.",
      inputSchema: {
        project_id: z.string().uuid().describe("Project id from list_projects"),
      },
    },
    async (input) => {
      await assertTokenScope(input.project_id);
      const project = await setActiveProjectForToken(
        session.tokenId,
        session.userId,
        input.project_id,
        session.tokenKind,
      );
      session.activeProjectId = project.id;
      return { content: [{ type: "text", text: JSON.stringify(project) }] };
    },
  );

  if (!session.telemetryOnly) {
    registerAlertTools(server, session, session.ch);
    registerDashboardTools(server, session);
    registerIncidentTools(server, session);
    registerAgentConfigTools(server, session, session.ch);
  }

  return server;
}
