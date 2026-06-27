import { db, schema } from "@superlog/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

export const dashboardWidgetTypeSchema = z.enum([
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
  showXAxis: z.boolean().optional(),
  showYAxis: z.boolean().optional(),
  showLegend: z.boolean().optional(),
  legendPosition: z.enum(["side", "bottom"]).optional(),
  markdown: z.string().max(20_000).optional(),
});

export const dashboardWidgetLayoutSchema = z.object({
  x: z.number().int().min(0).max(48),
  y: z.number().int().min(0).max(100000),
  w: z.number().int().min(1).max(48),
  h: z.number().int().min(1).max(100),
});

export type DashboardWidgetType = z.infer<typeof dashboardWidgetTypeSchema>;
export type DashboardWidgetLayout = z.infer<typeof dashboardWidgetLayoutSchema>;

// The standard widget size per type, against the 12-column grid the UI renders.
// Kept in sync with the web's `defaultLayoutFor` (apps/web/src/dashboards/types.ts).
// y=9999 means "append at the bottom": the grid compacts vertically on load.
export function defaultWidgetLayout(type: DashboardWidgetType): DashboardWidgetLayout {
  if (type === "markdown") return { x: 0, y: 9999, w: 4, h: 5 };
  if (type === "trace_table" || type === "log_table") return { x: 0, y: 9999, w: 12, h: 6 };
  return { x: 0, y: 9999, w: 6, h: 4 };
}

export const dashboardCreateSchema = z.object({ name: z.string().min(1).max(120) });
export const dashboardUpdateSchema = z.object({ name: z.string().min(1).max(120) });

export const dashboardWidgetCreateSchema = z.object({
  type: dashboardWidgetTypeSchema,
  title: z.string().min(1).max(200),
  config: dashboardWidgetConfigSchema,
  // Optional: when omitted, `addDashboardWidget` applies the standard size for
  // the widget type via `defaultWidgetLayout`.
  layout: dashboardWidgetLayoutSchema.optional(),
});

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

const slugFromName = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "dashboard";

export async function listDashboardsForProject(projectId: string): Promise<schema.Dashboard[]> {
  return db.query.dashboards.findMany({
    where: eq(schema.dashboards.projectId, projectId),
    orderBy: [asc(schema.dashboards.name)],
  });
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
    .values({ projectId, name: input.name, slug, createdBy: userId })
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
    .set({ name: input.name, updatedAt: new Date() })
    .where(and(eq(schema.dashboards.id, id), eq(schema.dashboards.projectId, projectId)))
    .returning();
  return updated[0] ?? null;
}

export async function deleteDashboard(projectId: string, id: string): Promise<void> {
  await db
    .delete(schema.dashboards)
    .where(and(eq(schema.dashboards.id, id), eq(schema.dashboards.projectId, projectId)));
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
  await db
    .delete(schema.dashboardWidgets)
    .where(
      and(
        eq(schema.dashboardWidgets.id, widgetId),
        eq(schema.dashboardWidgets.dashboardId, dashboardId),
      ),
    );
  return true;
}

export async function updateDashboardLayout(
  projectId: string,
  dashboardId: string,
  widgets: { id: string; layout: z.infer<typeof dashboardWidgetLayoutSchema> }[],
): Promise<boolean> {
  const dashboard = await ensureDashboardOwned(projectId, dashboardId);
  if (!dashboard) return false;
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
  return true;
}
