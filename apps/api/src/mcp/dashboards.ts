import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  addDashboardWidget,
  createDashboard,
  dashboardVariablesSchema,
  dashboardWidgetConfigSchema,
  dashboardWidgetLayoutSchema,
  dashboardWidgetTypeSchema,
  deleteDashboard,
  deleteDashboardWidget,
  getDashboardWithWidgets,
  listDashboardsForProject,
  setDashboardVariables,
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

// Shared, agent-facing explanation of the template-variable model. Used on both
// the `variables` parameter and the set_dashboard_variables tool so an agent
// learns the $name reference convention wherever it first lands.
const variablesDoc =
  "Dashboard template variables — a named picklist that drives widget filters. " +
  "Each entry is { name, options[], defaultValue?, label?, attributeKey? }. " +
  'A widget filter references a variable by putting the token "$name" (or "${name}") ' +
  'in a filter value — e.g. resourceAttrs: [{ key: "deployment.environment", value: "$env" }]. ' +
  "At view time the dashboard shows a dropdown per variable and substitutes the selected " +
  "option into every filter that references it, so one variable can drive filters across many " +
  "widgets on any attribute key. `options` is the selectable list (empty = free-form); " +
  "`defaultValue` must be one of `options` when `options` is non-empty; `attributeKey` is " +
  "optional and only powers a one-click 'filter by this variable' shortcut in the web editor. " +
  "Variable names must start with a letter and contain only letters, digits, or underscores.";

const variablesSchema = dashboardVariablesSchema.describe(variablesDoc);

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
      description:
        "Create a dashboard. Slug is generated from the name. Optionally seed template " +
        "variables (see `variables`) so widget filters can reference them with $name.",
      inputSchema: {
        project_id: projectIdSchema,
        name: z.string().min(1).max(120),
        variables: variablesSchema.optional(),
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      return text(
        await createDashboard(projectId, session.userId, {
          name: input.name,
          variables: input.variables,
        }),
      );
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
    "set_dashboard_variables",
    {
      title: "Set dashboard variables",
      description: `Replace a dashboard's template-variable list. Pass the FULL set you want to keep — this overwrites the existing list (read the current one with get_dashboard first). Variables let one dropdown drive filters across many widgets: define a variable here, then point widget filters at it with value:"$name". ${variablesDoc}`,
      inputSchema: {
        project_id: projectIdSchema,
        id: z.string().uuid(),
        variables: variablesSchema,
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const updated = await setDashboardVariables(projectId, input.id, input.variables);
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
        "Omit `layout` to use the standard size for the type — recommended. The grid is 12 columns wide, so x is 0-11 and w is 1-12; " +
        "the standard sizes are w:6 h:4 for timeseries charts (half-width), w:12 h:6 for trace_table/log_table (full-width), and " +
        "w:4 h:5 for markdown. Only pass `layout` when you deliberately want a non-standard size or position. " +
        'A filter value may reference a dashboard variable with the token "$name" (or "${name}") — e.g. ' +
        'config.filter.resourceAttrs: [{ key: "deployment.environment", value: "$env" }] — which is substituted ' +
        "with the viewer's selected option at view time. Define variables with set_dashboard_variables (or create_dashboard).",
      inputSchema: {
        project_id: projectIdSchema,
        dashboard_id: z.string().uuid(),
        type: dashboardWidgetTypeSchema,
        title: z.string().min(1).max(200),
        config: dashboardWidgetConfigSchema,
        layout: dashboardWidgetLayoutSchema
          .optional()
          .describe(
            "Grid placement {x,y,w,h} on a 12-column grid (x 0-11, w 1-12). Omit to use the standard size for the widget type.",
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
      description:
        "Patch a widget's title, config, or layout. As with add_dashboard_widget, a filter " +
        'value may reference a dashboard variable with the token "$name" (or "${name}").',
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
