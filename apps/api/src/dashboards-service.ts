import { db, schema } from "@superlog/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

export const dashboardWidgetTypeSchema = z.enum([
  "timeseries_count",
  "timeseries_metric",
  "trace_table",
  "log_table",
  "markdown",
  "link",
  "setup_todos",
  "active_incidents",
  "service_map",
  "incoming_signals",
  "incident_count",
  "agent_pull_requests",
]);

export const dashboardDataWidgetTypeSchema = z.enum([
  "timeseries_count",
  "timeseries_metric",
  "trace_table",
  "log_table",
  "markdown",
]);

const resourceAttrSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(500),
  op: z.enum(["eq", "neq", "not_contains"]).optional(),
});

export const dashboardWidgetConfigSchema = z.object({
  source: z.enum(["logs", "traces"]).optional(),
  filter: z.object({
    resourceAttrs: z.array(resourceAttrSchema).max(50).optional(),
  }),
  groupBy: z.string().max(200).optional(),
  metricName: z.string().max(200).optional(),
  aggregation: z.enum(["sum", "avg", "min", "max", "p95", "p99"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
  chartType: z.enum(["line", "bar"]).optional(),
  unit: z.enum(["none", "duration_ms", "duration_s", "bytes", "percent"]).optional(),
  showXAxis: z.boolean().optional(),
  showYAxis: z.boolean().optional(),
  showLegend: z.boolean().optional(),
  legendPosition: z.enum(["side", "bottom"]).optional(),
  markdown: z.string().max(20_000).optional(),
  url: z.string().url().max(2_000).optional(),
  description: z.string().max(500).optional(),
});

// Layouts are placed on the 12-column grid the UI renders (DashboardView.tsx
// uses cols=12), so a column index is 0..11 and a span is 1..12. Bounding the
// schema to the grid keeps it the single source of truth — an agent that sends
// w:48 is rejected here rather than producing a widget wider than the grid.
export const dashboardWidgetLayoutSchema = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(100000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(100),
});

export type DashboardWidgetType = z.infer<typeof dashboardWidgetTypeSchema>;
export type DashboardWidgetLayout = z.infer<typeof dashboardWidgetLayoutSchema>;

// The standard widget size per type, against the 12-column grid the UI renders.
// Kept in sync with the web's `defaultLayoutFor` (apps/web/src/dashboards/types.ts).
// y=9999 means "append at the bottom": the grid compacts vertically on load.
export function defaultWidgetLayout(type: DashboardWidgetType): DashboardWidgetLayout {
  switch (type) {
    case "markdown":
      return { x: 0, y: 9999, w: 4, h: 5 };
    case "link":
      return { x: 0, y: 9999, w: 3, h: 2 };
    case "setup_todos":
      return { x: 0, y: 0, w: 12, h: 5 };
    case "active_incidents":
      return { x: 0, y: 5, w: 6, h: 3 };
    case "service_map":
      return { x: 6, y: 5, w: 6, h: 8 };
    case "incoming_signals":
      return { x: 0, y: 5, w: 4, h: 5 };
    case "incident_count":
      return { x: 4, y: 5, w: 4, h: 5 };
    case "agent_pull_requests":
      return { x: 8, y: 5, w: 4, h: 5 };
    case "trace_table":
    case "log_table":
      return { x: 0, y: 9999, w: 12, h: 6 };
    case "timeseries_count":
    case "timeseries_metric":
      return { x: 0, y: 9999, w: 6, h: 4 };
    default: {
      // Exhaustiveness guard: adding a widget type to the enum without a case
      // here is a compile error rather than a silent fall-through.
      const _exhaustive: never = type;
      throw new Error(`unhandled widget type: ${String(_exhaustive)}`);
    }
  }
}

export const HOME_BUILTIN_TYPES = [
  "setup_todos",
  "active_incidents",
  "service_map",
  "incoming_signals",
  "incident_count",
  "agent_pull_requests",
] as const satisfies readonly DashboardWidgetType[];

export type HomeBuiltinType = (typeof HOME_BUILTIN_TYPES)[number];
export const homeBuiltinTypeSchema = z.enum(HOME_BUILTIN_TYPES);

function isHomeOnlyWidgetType(type: DashboardWidgetType): boolean {
  return type === "link" || HOME_BUILTIN_TYPES.includes(type as HomeBuiltinType);
}

export function dashboardRouteCanWriteWidget({
  existingType,
  requestedType,
}: {
  existingType?: DashboardWidgetType;
  requestedType?: DashboardWidgetType;
}): boolean {
  return !(
    (existingType && isHomeOnlyWidgetType(existingType)) ||
    (requestedType && isHomeOnlyWidgetType(requestedType))
  );
}

export function dashboardRouteCanMutateDashboard({
  isHome,
}: Pick<schema.Dashboard, "isHome">): boolean {
  return !isHome;
}

export function defaultHomeWidgets(): DashboardWidgetCreateInput[] {
  return [
    {
      type: "setup_todos",
      title: "Setup",
      config: { filter: {} },
      layout: defaultWidgetLayout("setup_todos"),
    },
    {
      type: "incoming_signals",
      title: "Incoming signals",
      config: { filter: {} },
      layout: defaultWidgetLayout("incoming_signals"),
    },
    {
      type: "incident_count",
      title: "Active incidents",
      config: { filter: {} },
      layout: defaultWidgetLayout("incident_count"),
    },
    {
      type: "agent_pull_requests",
      title: "PRs opened by Superlog",
      config: { filter: {} },
      layout: defaultWidgetLayout("agent_pull_requests"),
    },
  ];
}

// A dashboard-level template variable. Widget filters reference it from a
// `resourceAttrs[].value` using the token `$name` (or `${name}`); the dashboard
// substitutes the selected option at view time. `options` is the picklist shown
// in the variable bar. `attributeKey` is an optional convenience that lets the
// widget editor offer a one-click filter on that attribute — the variable can
// still be referenced from any filter via `$name`.
const dashboardVariableSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      "name must start with a letter and contain only letters, digits, or underscores",
    )
    .max(60),
  label: z.string().max(120).optional(),
  options: z.array(z.string().max(500)).max(200),
  defaultValue: z.string().max(500).optional(),
  attributeKey: z.string().max(200).optional(),
});

export const dashboardVariablesSchema = z
  .array(dashboardVariableSchema)
  .max(50)
  .superRefine((vars, ctx) => {
    const seen = new Set<string>();
    for (const v of vars) {
      if (seen.has(v.name)) {
        ctx.addIssue({ code: "custom", message: `duplicate variable name: ${v.name}` });
      }
      seen.add(v.name);
      // An empty options list means the value is free-form, so any default is
      // allowed; otherwise the default has to be a selectable option.
      if (
        v.defaultValue !== undefined &&
        v.options.length > 0 &&
        !v.options.includes(v.defaultValue)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `defaultValue "${v.defaultValue}" is not one of the options for variable "${v.name}"`,
        });
      }
    }
  });

export const dashboardCreateSchema = z.object({
  name: z.string().min(1).max(120),
  variables: dashboardVariablesSchema.optional(),
});
export const dashboardUpdateSchema = z.object({
  name: z.string().min(1).max(120),
  variables: dashboardVariablesSchema.optional(),
});

export type DashboardVariableInput = z.infer<typeof dashboardVariableSchema>;

export const dashboardWidgetCreateSchema = z.object({
  type: dashboardWidgetTypeSchema,
  title: z.string().min(1).max(200),
  config: dashboardWidgetConfigSchema,
  // Optional: when omitted, `addDashboardWidget` applies the standard size for
  // the widget type via `defaultWidgetLayout`.
  layout: dashboardWidgetLayoutSchema.optional(),
});

export const homeDataWidgetCreateSchema = dashboardWidgetCreateSchema.refine(
  (input) => input.type !== "link" && !HOME_BUILTIN_TYPES.includes(input.type as HomeBuiltinType),
  "home data widgets must use a chart, table, or markdown type",
);

export const dashboardWidgetUpdateSchema = z.object({
  type: dashboardWidgetTypeSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  config: dashboardWidgetConfigSchema.optional(),
  layout: dashboardWidgetLayoutSchema.optional(),
});

export type DashboardCreateInput = z.infer<typeof dashboardCreateSchema>;
export type DashboardUpdateInput = z.infer<typeof dashboardUpdateSchema>;
export type DashboardWidgetCreateInput = z.infer<typeof dashboardWidgetCreateSchema>;
export type DashboardWidgetUpdateInput = z.infer<typeof dashboardWidgetUpdateSchema>;

export const homeLinkCreateSchema = z.object({
  title: z.string().min(1).max(200),
  url: z
    .string()
    .url()
    .max(2_000)
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "URL must use http or https"),
  description: z.string().max(500).optional(),
});

export type HomeLinkCreateInput = z.infer<typeof homeLinkCreateSchema>;

const slugFromName = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "dashboard";

export async function listDashboardsForProject(projectId: string): Promise<schema.Dashboard[]> {
  return db.query.dashboards.findMany({
    where: and(eq(schema.dashboards.projectId, projectId), eq(schema.dashboards.isHome, false)),
    orderBy: [asc(schema.dashboards.name)],
  });
}

export async function getOrCreateHomeDashboard(
  projectId: string,
  userId: string,
): Promise<schema.Dashboard & { widgets: schema.DashboardWidget[] }> {
  const existing = await db.query.dashboards.findFirst({
    where: and(eq(schema.dashboards.projectId, projectId), eq(schema.dashboards.isHome, true)),
  });
  if (existing) {
    const widgets = await db.query.dashboardWidgets.findMany({
      where: eq(schema.dashboardWidgets.dashboardId, existing.id),
      orderBy: [asc(schema.dashboardWidgets.position)],
    });
    return { ...existing, widgets };
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.dashboards)
      .values({
        projectId,
        name: "Home",
        slug: "__home__",
        isHome: true,
        createdBy: userId,
      })
      .onConflictDoNothing()
      .returning();

    const home =
      inserted[0] ??
      (await tx.query.dashboards.findFirst({
        where: and(eq(schema.dashboards.projectId, projectId), eq(schema.dashboards.isHome, true)),
      }));
    if (!home) throw new Error("failed to create project home dashboard");

    if (inserted[0]) {
      await tx.insert(schema.dashboardWidgets).values(
        defaultHomeWidgets().map((widget, position) => ({
          dashboardId: home.id,
          type: widget.type,
          title: widget.title,
          config: widget.config,
          layout: widget.layout ?? defaultWidgetLayout(widget.type),
          position,
        })),
      );
    }

    const widgets = await tx.query.dashboardWidgets.findMany({
      where: eq(schema.dashboardWidgets.dashboardId, home.id),
      orderBy: [asc(schema.dashboardWidgets.position)],
    });
    return { ...home, widgets };
  });
}

export async function setHomeBuiltin(
  projectId: string,
  userId: string,
  type: HomeBuiltinType,
  enabled: boolean,
): Promise<schema.Dashboard & { widgets: schema.DashboardWidget[] }> {
  const home = await getOrCreateHomeDashboard(projectId, userId);
  const existing = home.widgets.find((widget) => widget.type === type);
  if (enabled && !existing) {
    const definition = defaultHomeWidgets().find((widget) => widget.type === type);
    if (!definition) throw new Error(`missing definition for home widget: ${type}`);
    await insertDashboardWidget(home.id, definition);
  }
  if (!enabled && existing) {
    await removeDashboardWidget(home.id, existing.id);
  }
  return (await getDashboardWithWidgets(projectId, home.id)) ?? home;
}

export async function addHomeLink(
  projectId: string,
  userId: string,
  input: HomeLinkCreateInput,
): Promise<schema.DashboardWidget> {
  const safeInput = homeLinkCreateSchema.parse(input);
  const home = await getOrCreateHomeDashboard(projectId, userId);
  const widget = await insertDashboardWidget(home.id, {
    type: "link",
    title: safeInput.title,
    config: { filter: {}, url: safeInput.url, description: safeInput.description },
  });
  if (!widget) throw new Error("failed to add home link");
  return widget;
}

export async function addHomeDataWidget(
  projectId: string,
  userId: string,
  input: DashboardWidgetCreateInput,
): Promise<schema.DashboardWidget> {
  if (isHomeOnlyWidgetType(input.type)) {
    throw new Error("use the dedicated home built-in or link operation");
  }
  const home = await getOrCreateHomeDashboard(projectId, userId);
  const widget = await insertDashboardWidget(home.id, input);
  if (!widget) throw new Error("failed to add home widget");
  return widget;
}

export async function deleteHomeItem(
  projectId: string,
  userId: string,
  itemId: string,
): Promise<boolean> {
  const home = await getOrCreateHomeDashboard(projectId, userId);
  if (!home.widgets.some((widget) => widget.id === itemId)) return false;
  return removeDashboardWidget(home.id, itemId);
}

export async function updateHomeLayout(
  projectId: string,
  userId: string,
  widgets: { id: string; layout: z.infer<typeof dashboardWidgetLayoutSchema> }[],
): Promise<void> {
  const home = await getOrCreateHomeDashboard(projectId, userId);
  await updateDashboardLayoutItems(home.id, widgets);
}

export async function getDashboardWithWidgets(
  projectId: string,
  id: string,
): Promise<(schema.Dashboard & { widgets: schema.DashboardWidget[] }) | null> {
  const dashboard = await db.query.dashboards.findFirst({
    where: and(eq(schema.dashboards.id, id), eq(schema.dashboards.projectId, projectId)),
  });
  if (!dashboard) return null;
  const widgets = await db.query.dashboardWidgets.findMany({
    where: eq(schema.dashboardWidgets.dashboardId, id),
    orderBy: [asc(schema.dashboardWidgets.position)],
  });
  return { ...dashboard, widgets };
}

export async function createDashboard(
  projectId: string,
  userId: string,
  input: DashboardCreateInput,
): Promise<schema.Dashboard> {
  const baseSlug = slugFromName(input.name);
  let slug = baseSlug;
  for (let i = 2; i < 100; i++) {
    const existing = await db.query.dashboards.findFirst({
      where: and(eq(schema.dashboards.projectId, projectId), eq(schema.dashboards.slug, slug)),
    });
    if (!existing) break;
    slug = `${baseSlug}-${i}`;
  }
  const inserted = await db
    .insert(schema.dashboards)
    .values({
      projectId,
      name: input.name,
      slug,
      createdBy: userId,
      ...(input.variables !== undefined ? { variables: input.variables } : {}),
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("dashboards insert returned no rows");
  return row;
}

export async function updateDashboard(
  projectId: string,
  id: string,
  input: DashboardUpdateInput,
): Promise<schema.Dashboard | null> {
  const updated = await db
    .update(schema.dashboards)
    .set({
      name: input.name,
      ...(input.variables !== undefined ? { variables: input.variables } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.dashboards.id, id),
        eq(schema.dashboards.projectId, projectId),
        eq(schema.dashboards.isHome, false),
      ),
    )
    .returning();
  return updated[0] ?? null;
}

export async function setDashboardVariables(
  projectId: string,
  id: string,
  variables: DashboardVariableInput[],
): Promise<schema.Dashboard | null> {
  const updated = await db
    .update(schema.dashboards)
    .set({ variables, updatedAt: new Date() })
    .where(
      and(
        eq(schema.dashboards.id, id),
        eq(schema.dashboards.projectId, projectId),
        eq(schema.dashboards.isHome, false),
      ),
    )
    .returning();
  return updated[0] ?? null;
}

export async function deleteDashboard(projectId: string, id: string): Promise<void> {
  await db
    .delete(schema.dashboards)
    .where(
      and(
        eq(schema.dashboards.id, id),
        eq(schema.dashboards.projectId, projectId),
        eq(schema.dashboards.isHome, false),
      ),
    );
}

async function ensureDashboardOwned(
  projectId: string,
  dashboardId: string,
): Promise<schema.Dashboard | null> {
  return (
    (await db.query.dashboards.findFirst({
      where: and(eq(schema.dashboards.id, dashboardId), eq(schema.dashboards.projectId, projectId)),
    })) ?? null
  );
}

export async function addDashboardWidget(
  projectId: string,
  dashboardId: string,
  input: DashboardWidgetCreateInput,
): Promise<schema.DashboardWidget | null> {
  const dashboard = await ensureDashboardOwned(projectId, dashboardId);
  if (!dashboard) return null;
  if (!dashboardRouteCanMutateDashboard(dashboard)) return null;
  if (!dashboardRouteCanWriteWidget({ requestedType: input.type })) return null;
  return insertDashboardWidget(dashboardId, input);
}

async function insertDashboardWidget(
  dashboardId: string,
  input: DashboardWidgetCreateInput,
): Promise<schema.DashboardWidget | null> {
  const existing = await db.query.dashboardWidgets.findMany({
    where: eq(schema.dashboardWidgets.dashboardId, dashboardId),
  });
  const nextPosition = existing.reduce((m, w) => Math.max(m, w.position), -1) + 1;
  const inserted = await db
    .insert(schema.dashboardWidgets)
    .values({
      dashboardId,
      type: input.type,
      title: input.title,
      config: input.config,
      layout: input.layout ?? defaultWidgetLayout(input.type),
      position: nextPosition,
    })
    .returning();
  await db
    .update(schema.dashboards)
    .set({ updatedAt: new Date() })
    .where(eq(schema.dashboards.id, dashboardId));
  return inserted[0] ?? null;
}

export async function updateDashboardWidget(
  projectId: string,
  dashboardId: string,
  widgetId: string,
  input: DashboardWidgetUpdateInput,
): Promise<schema.DashboardWidget | null> {
  const dashboard = await ensureDashboardOwned(projectId, dashboardId);
  if (!dashboard) return null;
  if (!dashboardRouteCanMutateDashboard(dashboard)) return null;
  const existing = await db.query.dashboardWidgets.findFirst({
    where: and(
      eq(schema.dashboardWidgets.id, widgetId),
      eq(schema.dashboardWidgets.dashboardId, dashboardId),
    ),
  });
  if (!existing) return null;
  if (
    !dashboardRouteCanWriteWidget({
      existingType: existing.type,
      requestedType: input.type,
    })
  ) {
    return null;
  }
  const updated = await db
    .update(schema.dashboardWidgets)
    .set({
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.layout !== undefined ? { layout: input.layout } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.dashboardWidgets.id, widgetId),
        eq(schema.dashboardWidgets.dashboardId, dashboardId),
      ),
    )
    .returning();
  if (!updated[0]) return null;
  await db
    .update(schema.dashboards)
    .set({ updatedAt: new Date() })
    .where(eq(schema.dashboards.id, dashboardId));
  return updated[0];
}

export async function deleteDashboardWidget(
  projectId: string,
  dashboardId: string,
  widgetId: string,
): Promise<boolean> {
  const dashboard = await ensureDashboardOwned(projectId, dashboardId);
  if (!dashboard) return false;
  if (!dashboardRouteCanMutateDashboard(dashboard)) return false;
  return removeDashboardWidget(dashboardId, widgetId);
}

async function removeDashboardWidget(dashboardId: string, widgetId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.dashboardWidgets)
    .where(
      and(
        eq(schema.dashboardWidgets.id, widgetId),
        eq(schema.dashboardWidgets.dashboardId, dashboardId),
      ),
    )
    .returning({ id: schema.dashboardWidgets.id });
  return deleted.length > 0;
}

export async function updateDashboardLayout(
  projectId: string,
  dashboardId: string,
  widgets: { id: string; layout: z.infer<typeof dashboardWidgetLayoutSchema> }[],
): Promise<boolean> {
  const dashboard = await ensureDashboardOwned(projectId, dashboardId);
  if (!dashboard) return false;
  if (!dashboardRouteCanMutateDashboard(dashboard)) return false;
  await updateDashboardLayoutItems(dashboardId, widgets);
  return true;
}

async function updateDashboardLayoutItems(
  dashboardId: string,
  widgets: { id: string; layout: z.infer<typeof dashboardWidgetLayoutSchema> }[],
): Promise<void> {
  await Promise.all(
    widgets.map((w) =>
      db
        .update(schema.dashboardWidgets)
        .set({ layout: w.layout, updatedAt: new Date() })
        .where(
          and(
            eq(schema.dashboardWidgets.id, w.id),
            eq(schema.dashboardWidgets.dashboardId, dashboardId),
          ),
        ),
    ),
  );
  await db
    .update(schema.dashboards)
    .set({ updatedAt: new Date() })
    .where(eq(schema.dashboards.id, dashboardId));
}
