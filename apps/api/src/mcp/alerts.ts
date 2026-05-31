import type { ClickHouseClient } from "@clickhouse/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  alertAggregationSchema,
  alertComparatorSchema,
  alertFilterSchema,
  alertGroupModeSchema,
  alertInputSchema,
  alertSourceSchema,
  createAlertRecord,
  deleteAlertRecord,
  getAlertWithFirings,
  listAlertsForProject,
  previewAlert,
  testAlertById,
  updateAlertRecord,
} from "../alerts-service.js";
import { assertProjectAccess } from "./projects.js";

const projectIdSchema = z
  .string()
  .uuid()
  .optional()
  .describe(
    "Project to operate on. Defaults to the session's active project. Use list_projects to discover ids.",
  );

const alertIdSchema = z.string().uuid().describe("Alert id");

// Shape (not z.object) for MCP tools that take the full alert body.
const alertInputShape = {
  name: z.string().min(1).max(200),
  source: alertSourceSchema.describe("Telemetry source: 'logs', 'traces', or 'metric'"),
  aggregation: alertAggregationSchema.describe(
    "'count' for logs/traces; 'sum' or 'avg' for metric",
  ),
  comparator: alertComparatorSchema.describe(
    "'gt' fires when value > threshold; 'lt' is the opposite",
  ),
  threshold: z.number().finite(),
  enabled: z.boolean().optional(),
  metric_name: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Required when source = 'metric'"),
  filter: alertFilterSchema
    .optional()
    .describe("Equality filters narrowing the data the alert evaluates"),
  group_by: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Resource attribute to group by, e.g. 'service.name'"),
  group_mode: alertGroupModeSchema
    .optional()
    .describe("'single' rolls up everything; 'per_group' fires per distinct group_by value"),
  window_minutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .describe("Evaluation window. Default 5"),
  evaluation_interval_seconds: z.number().int().min(15).max(3600).optional(),
} as const;

type AlertInputArgs = {
  name?: string;
  source?: z.infer<typeof alertSourceSchema>;
  aggregation?: z.infer<typeof alertAggregationSchema>;
  comparator?: z.infer<typeof alertComparatorSchema>;
  threshold?: number;
  enabled?: boolean;
  metric_name?: string | null;
  filter?: z.infer<typeof alertFilterSchema>;
  group_by?: string | null;
  group_mode?: z.infer<typeof alertGroupModeSchema>;
  window_minutes?: number;
  evaluation_interval_seconds?: number;
};

function toAlertInput(args: AlertInputArgs): z.infer<typeof alertInputSchema> {
  const partial = {
    name: args.name,
    source: args.source,
    aggregation: args.aggregation,
    comparator: args.comparator,
    threshold: args.threshold,
    enabled: args.enabled,
    metricName: args.metric_name,
    filter: args.filter,
    groupBy: args.group_by,
    groupMode: args.group_mode,
    windowMinutes: args.window_minutes,
    evaluationIntervalSeconds: args.evaluation_interval_seconds,
  };
  return alertInputSchema.parse(partial);
}

function toAlertPatch(args: AlertInputArgs): Partial<z.infer<typeof alertInputSchema>> {
  const patch: Partial<z.infer<typeof alertInputSchema>> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.source !== undefined) patch.source = args.source;
  if (args.aggregation !== undefined) patch.aggregation = args.aggregation;
  if (args.comparator !== undefined) patch.comparator = args.comparator;
  if (args.threshold !== undefined) patch.threshold = args.threshold;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.metric_name !== undefined) patch.metricName = args.metric_name;
  if (args.filter !== undefined) patch.filter = args.filter;
  if (args.group_by !== undefined) patch.groupBy = args.group_by;
  if (args.group_mode !== undefined) patch.groupMode = args.group_mode;
  if (args.window_minutes !== undefined) patch.windowMinutes = args.window_minutes;
  if (args.evaluation_interval_seconds !== undefined) {
    patch.evaluationIntervalSeconds = args.evaluation_interval_seconds;
  }
  return alertInputSchema.partial().parse(patch);
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function registerAlertTools(
  server: McpServer,
  session: { userId: string; activeProjectId: string },
  ch: ClickHouseClient,
): void {
  const resolve = async (explicit: string | undefined): Promise<string> => {
    const id = explicit ?? session.activeProjectId;
    await assertProjectAccess(session.userId, id);
    return id;
  };

  server.registerTool(
    "list_alerts",
    {
      title: "List alerts",
      description: "List all alerts in the active project (or the project_id you pass).",
      inputSchema: { project_id: projectIdSchema },
    },
    async (input) => text(await listAlertsForProject(await resolve(input.project_id))),
  );

  server.registerTool(
    "get_alert",
    {
      title: "Get alert",
      description: "Fetch a single alert plus its 50 most recent firings.",
      inputSchema: { project_id: projectIdSchema, id: alertIdSchema },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const alert = await getAlertWithFirings(projectId, input.id);
      if (!alert) throw new HTTPException(404, { message: "alert not found" });
      return text(alert);
    },
  );

  server.registerTool(
    "create_alert",
    {
      title: "Create alert",
      description:
        "Create an alert. For logs/traces sources aggregation must be 'count'; for metric source it must be 'sum' or 'avg' and metric_name is required.",
      inputSchema: { project_id: projectIdSchema, ...alertInputShape },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const created = await createAlertRecord(projectId, session.userId, toAlertInput(input));
      return text(created);
    },
  );

  server.registerTool(
    "update_alert",
    {
      title: "Update alert",
      description:
        "Patch an alert. Provide only the fields you want to change. Validation runs on the merged result.",
      inputSchema: {
        project_id: projectIdSchema,
        id: alertIdSchema,
        name: alertInputShape.name.optional(),
        source: alertInputShape.source.optional(),
        aggregation: alertInputShape.aggregation.optional(),
        comparator: alertInputShape.comparator.optional(),
        threshold: alertInputShape.threshold.optional(),
        enabled: alertInputShape.enabled,
        metric_name: alertInputShape.metric_name,
        filter: alertInputShape.filter,
        group_by: alertInputShape.group_by,
        group_mode: alertInputShape.group_mode,
        window_minutes: alertInputShape.window_minutes,
        evaluation_interval_seconds: alertInputShape.evaluation_interval_seconds,
      },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const updated = await updateAlertRecord(projectId, input.id, toAlertPatch(input));
      if (!updated) throw new HTTPException(404, { message: "alert not found" });
      return text(updated);
    },
  );

  server.registerTool(
    "delete_alert",
    {
      title: "Delete alert",
      description: "Delete an alert by id.",
      inputSchema: { project_id: projectIdSchema, id: alertIdSchema },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      await deleteAlertRecord(projectId, input.id, session.userId);
      return text({ ok: true });
    },
  );

  server.registerTool(
    "preview_alert",
    {
      title: "Preview alert",
      description:
        "Evaluate a draft alert spec against current data without saving. Returns whether it would breach right now.",
      inputSchema: { project_id: projectIdSchema, ...alertInputShape },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      return text(await previewAlert(ch, projectId, toAlertInput(input)));
    },
  );

  server.registerTool(
    "test_alert",
    {
      title: "Test alert",
      description: "Re-evaluate a saved alert against current data and return the result.",
      inputSchema: { project_id: projectIdSchema, id: alertIdSchema },
    },
    async (input) => {
      const projectId = await resolve(input.project_id);
      const result = await testAlertById(ch, projectId, input.id);
      if (!result) throw new HTTPException(404, { message: "alert not found" });
      return text(result);
    },
  );
}
