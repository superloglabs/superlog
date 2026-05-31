// Creates a "Tenant activity" dashboard with 7 widgets that read the
// self-emitted metrics from `apps/proxy/src/tenant-metrics.ts` and
// `apps/worker/src/tenant-metrics.ts`. Run after both services are deployed.
//
//   DATABASE_URL=... \
//     pnpm tsx scripts/seed-tenant-activity-dashboard.ts <projectId> <userId>
//
// Idempotent on (project, slug "tenant-activity") — replaces widgets on rerun
// so layout/config tweaks here become the source of truth.
import process from "node:process";
import { and, eq } from "drizzle-orm";

const DASHBOARD_NAME = "Tenant activity";
const DASHBOARD_SLUG = "tenant-activity";

type WidgetSpec = {
  type: "timeseries_metric";
  title: string;
  metricName: string;
  layout: { x: number; y: number; w: number; h: number };
};

const WIDGETS: WidgetSpec[] = [
  // Row 1 — ingest counters (proxy)
  {
    type: "timeseries_metric",
    title: "Traces received by org",
    metricName: "superlog.tenant.traces.received",
    layout: { x: 0, y: 0, w: 4, h: 6 },
  },
  {
    type: "timeseries_metric",
    title: "Logs received by org",
    metricName: "superlog.tenant.logs.received",
    layout: { x: 4, y: 0, w: 4, h: 6 },
  },
  {
    type: "timeseries_metric",
    title: "Metric points received by org",
    metricName: "superlog.tenant.metric_points.received",
    layout: { x: 8, y: 0, w: 4, h: 6 },
  },
  // Row 2 — Postgres-derived gauges (worker)
  {
    type: "timeseries_metric",
    title: "Open issues by org",
    metricName: "superlog.tenant.issues.open",
    layout: { x: 0, y: 6, w: 3, h: 6 },
  },
  {
    type: "timeseries_metric",
    title: "Open incidents by org",
    metricName: "superlog.tenant.incidents.open",
    layout: { x: 3, y: 6, w: 3, h: 6 },
  },
  {
    type: "timeseries_metric",
    title: "Open agent PRs by org",
    metricName: "superlog.tenant.prs.open",
    layout: { x: 6, y: 6, w: 3, h: 6 },
  },
  {
    type: "timeseries_metric",
    title: "Merged agent PRs (cumulative) by org",
    metricName: "superlog.tenant.prs.merged_total",
    layout: { x: 9, y: 6, w: 3, h: 6 },
  },
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const [projectId, userId] = process.argv.slice(2);
  if (!projectId || !userId) {
    throw new Error("usage: seed-tenant-activity-dashboard.ts <projectId> <userId>");
  }

  const [{ db }, schema] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
  ]);

  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!project) throw new Error(`project ${projectId} not found`);
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new Error(`user ${userId} not found`);

  let dashboard = await db.query.dashboards.findFirst({
    where: and(
      eq(schema.dashboards.projectId, projectId),
      eq(schema.dashboards.slug, DASHBOARD_SLUG),
    ),
  });
  if (!dashboard) {
    const inserted = await db
      .insert(schema.dashboards)
      .values({
        projectId,
        name: DASHBOARD_NAME,
        slug: DASHBOARD_SLUG,
        createdBy: userId,
      })
      .returning();
    dashboard = inserted[0];
    if (!dashboard) throw new Error("failed to insert dashboard");
  }

  // Reseed widgets from scratch so this script is the source of truth.
  await db
    .delete(schema.dashboardWidgets)
    .where(eq(schema.dashboardWidgets.dashboardId, dashboard.id));

  const dashboardId = dashboard.id;
  await db.insert(schema.dashboardWidgets).values(
    WIDGETS.map((w, i) => ({
      dashboardId,
      type: w.type,
      title: w.title,
      config: {
        filter: { resourceAttrs: [] },
        metricName: w.metricName,
        groupBy: "attr:tenant.org.name",
      },
      layout: w.layout,
      position: i,
    })),
  );

  await db
    .update(schema.dashboards)
    .set({ updatedAt: new Date() })
    .where(eq(schema.dashboards.id, dashboard.id));

  console.log(
    JSON.stringify(
      {
        dashboard: { id: dashboard.id, name: dashboard.name, slug: dashboard.slug },
        widgetCount: WIDGETS.length,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
