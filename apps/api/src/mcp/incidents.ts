import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getIncidentDetail } from "../incidents/detail.js";
import { searchIncidents } from "../incidents/search.js";
import { assertProjectAccess } from "./projects.js";

const projectIdSchema = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Project to search. Defaults to the session's active project. Use list_projects to discover ids.",
  );

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function registerIncidentTools(
  server: McpServer,
  session: { userId: string; activeProjectId: string; allowedOrgId?: string },
): void {
  // For org-scoped MCP tokens, reject any project outside the token's org —
  // even one the user is individually a member of. Mirrors the boundary every
  // telemetry tool enforces via server.ts's resolveProject. Both an explicit
  // project_id (search_incidents) and an incident's resolved project
  // (get_incident, which takes a bare global id) must pass this.
  const assertTokenScope = async (projectId: string): Promise<void> => {
    if (!session.allowedOrgId) return;
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, projectId),
    });
    if (!project || project.orgId !== session.allowedOrgId) {
      throw new HTTPException(403, { message: "project is outside this MCP token's org scope" });
    }
  };

  const resolve = async (explicit: string | undefined): Promise<string> => {
    const id = explicit ?? session.activeProjectId;
    await assertTokenScope(id);
    await assertProjectAccess(session.userId, id);
    return id;
  };

  server.registerTool(
    "get_incident",
    {
      title: "Get incident",
      description:
        "Fetch one incident by its id — the uuid at the end of a superlog.sh/org/<org>/project/<project>/incidents/<id> link — and everything needed to explain it. " +
        "No project_id is required; the project is resolved from the incident. Returns: the incident summary with the agent's findings (root_cause_text, agent_summary, estimated_impact_text) and its project_id; every linked issue with a stored telemetry `sample` (trace_id, span_id, stacktrace, span/log/resource attributes); and a pointer to the latest investigation run. " +
        "To pull live telemetry, take a sample's trace_id and call query_traces, or filter query_logs/query_traces by the issue's service + exception type — passing the returned project_id.",
      inputSchema: {
        incident_id: z.string().uuid().describe("Incident id (the uuid from the incident URL)."),
      },
    },
    async (input) => {
      const detail = await getIncidentDetail(input.incident_id);
      if (!detail) throw new HTTPException(404, { message: "incident not found" });
      await assertProjectAccess(session.userId, detail.incident.projectId);
      await assertTokenScope(detail.incident.projectId);
      return text(detail);
    },
  );

  server.registerTool(
    "search_incidents",
    {
      title: "Search incidents",
      description:
        "Search incidents in the active project (or project_id). Incidents are auto-grouped error/anomaly investigations; each row carries the agent's findings (agent_summary, root_cause_text) when available. " +
        "Filter by status, severity, service, a free-text substring over title/codename, and a last_seen time window. Results are newest-activity-first. " +
        "By default agent-classified noise (status='autoresolved_noise') is hidden; pass status='all' to include it or status='autoresolved_noise' to inspect just the noise pile. " +
        "Use get_incident to drill into a single incident's linked issues and telemetry.",
      inputSchema: {
        project_id: projectIdSchema,
        status: z
          .enum(["open", "resolved", "autoresolved_noise", "merged", "all"])
          .optional()
          .describe(
            "Incident status filter. Omit to see everything except auto-classified noise; 'all' includes noise.",
          ),
        severity: z
          .enum(["SEV-1", "SEV-2", "SEV-3"])
          .optional()
          .describe("Filter by assigned severity."),
        service: z
          .string()
          .optional()
          .describe("Exact match on the incident's primary service.name."),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against incident title and codename."),
        since: z
          .string()
          .optional()
          .describe("ISO-8601 timestamp; only incidents with last_seen >= since are returned."),
        until: z
          .string()
          .optional()
          .describe("ISO-8601 timestamp; only incidents with last_seen <= until are returned."),
        limit: z.number().int().positive().max(200).default(50),
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const incidents = await searchIncidents(projectId, {
        status: input.status,
        severity: input.severity,
        service: input.service,
        query: input.query,
        since: input.since,
        until: input.until,
        limit: input.limit,
      });
      return text({ count: incidents.length, incidents });
    },
  );
}
