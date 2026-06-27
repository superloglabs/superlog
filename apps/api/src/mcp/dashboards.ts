import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  addDashboardWidget,
  createDashboard,
  dashboardWidgetConfigSchema,
  dashboardWidgetLayoutSchema,
  dashboardWidgetTypeSchema,
  deleteDashboard,
  deleteDashboardWidget,
  getDashboardWithWidgets,
  listDashboardsForProject,
  updateDashboard,
  updateDashboardWidget,
} from "../dashboards-service.js";
import { assertProjectAccess } from "./projects.js";

const projectIdSchema = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Project to operate on. Defaults to the session's active project. Use list_projects to discover ids.",
  );

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function registerDashboardTools(
  server: McpServer,
  session: { userId: string; activeProjectId: string },
): void {
  const resolve = async (explicit: string | undefined): Promise<string> => {
    const id = explicit ?? session.activeProjectId;
    await assertProjectAccess(session.userId, id);
    return id;
  };

  server.registerTool(
    "list_dashboards",
    {
      title: "List dashboards",
      description: "List dashboards in the active project (or project_id).",
      inputSchema: { project_id: projectIdSchema },
    },
    async (input) => text(await listDashboardsForProject(await resolve(input.project_id))),
  );

  server.registerTool(
    "get_dashboard",
    {
      title: "Get dashboard",
      description: "Fetch a dashboard with its widgets.",
      inputSchema: { project_id: projectIdSchema, id: z.string().uuid() },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const dashboard = await getDashboardWithWidgets(projectId, input.id);
      if (!dashboard) throw new HTTPException(404, { message: "dashboard not found" });
      return text(dashboard);
    },
  );

  server.registerTool(
    "create_dashboard",
    {
      title: "Create dashboard",
      description: "Create an empty dashboard. Slug is generated from the name.",
      inputSchema: {
        project_id: projectIdSchema,
        name: z.string().min(1).max(120),
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      return text(await createDashboard(projectId, session.userId, { name: input.name }));
    },
  );

  server.registerTool(
    "update_dashboard",
    {
      title: "Update dashboard",
      description: "Rename a dashboard.",
      inputSchema: {
        project_id: projectIdSchema,
        id: z.string().uuid(),
        name: z.string().min(1).max(120),
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const updated = await updateDashboard(projectId, input.id, { name: input.name });
      if (!updated) throw new HTTPException(404, { message: "dashboard not found" });
      return text(updated);
    },
  );

  server.registerTool(
    "delete_dashboard",
    {
      title: "Delete dashboard",
      description: "Delete a dashboard and all its widgets.",
      inputSchema: { project_id: projectIdSchema, id: z.string().uuid() },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      await deleteDashboard(projectId, input.id);
      return text({ ok: true });
    },
  );

  server.registerTool(
    "add_dashboard_widget",
    {
      title: "Add dashboard widget",
      description:
        "Append a widget to a dashboard. Widget types: timeseries_count, timeseries_metric, trace_table, log_table, markdown. " +
        "Omit `layout` to use the standard size for the type — recommended. The grid is 12 columns wide; the standard sizes are " +
        "w:6 h:4 for timeseries charts (half-width), w:12 h:6 for trace_table/log_table (full-width), and w:4 h:5 for markdown. " +
        "Only pass `layout` when you deliberately want a non-standard size or position.",
      inputSchema: {
        project_id: projectIdSchema,
        dashboard_id: z.string().uuid(),
        type: dashboardWidgetTypeSchema,
        title: z.string().min(1).max(200),
        config: dashboardWidgetConfigSchema,
        layout: dashboardWidgetLayoutSchema
          .optional()
          .describe(
            "Grid placement {x,y,w,h} on a 12-column grid. Omit to use the standard size for the widget type.",
          ),
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const widget = await addDashboardWidget(projectId, input.dashboard_id, {
        type: input.type,
        title: input.title,
        config: input.config,
        layout: input.layout,
      });
      if (!widget) throw new HTTPException(404, { message: "dashboard not found" });
      return text(widget);
    },
  );

  server.registerTool(
    "update_dashboard_widget",
    {
      title: "Update dashboard widget",
      description: "Patch a widget's title, config, or layout.",
      inputSchema: {
        project_id: projectIdSchema,
        dashboard_id: z.string().uuid(),
        widget_id: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        config: dashboardWidgetConfigSchema.optional(),
        layout: dashboardWidgetLayoutSchema.optional(),
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const widget = await updateDashboardWidget(projectId, input.dashboard_id, input.widget_id, {
        title: input.title,
        config: input.config,
        layout: input.layout,
      });
      if (!widget) throw new HTTPException(404, { message: "widget not found" });
      return text(widget);
    },
  );

  server.registerTool(
    "delete_dashboard_widget",
    {
      title: "Delete dashboard widget",
      description: "Remove a widget from a dashboard.",
      inputSchema: {
        project_id: projectIdSchema,
        dashboard_id: z.string().uuid(),
        widget_id: z.string().uuid(),
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const ok = await deleteDashboardWidget(projectId, input.dashboard_id, input.widget_id);
      if (!ok) throw new HTTPException(404, { message: "dashboard not found" });
      return text({ ok: true });
    },
  );
}
