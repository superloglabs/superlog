// Seeds the "Worker telemetry ingest" dashboard in a Superlog project.
// Idempotent: replaces widgets on the existing slug if the dashboard exists.
//
// Usage (against prod via Railway):
//   railway run --service worker pnpm seed:worker-telemetry-dashboard \
//     --project-id b925b1df-5b78-43c8-a816-6f00afb174af
//
// Locally against the worktree DB:
//   pnpm --filter @superlog/worker seed:worker-telemetry-dashboard -- --project-id <uuid>
import "../src/env.js";
import {
  type DashboardWidgetConfig,
  type DashboardWidgetLayout,
  type DashboardWidgetType,
  db,
  schema,
} from "@superlog/db";
import { and, eq } from "drizzle-orm";

function parseArgs(argv: string[]): { projectId: string } {
  const idx = argv.indexOf("--project-id");
  if (idx === -1) {
    throw new Error("--project-id <uuid> is required");
  }
  const projectId = argv[idx + 1];
  if (!projectId) {
    throw new Error("--project-id <uuid> is required");
  }
  return { projectId };
}

const DASHBOARD_SLUG = "worker-telemetry-ingest";
const DASHBOARD_NAME = "Worker telemetry ingest";

type WidgetSpec = {
  type: DashboardWidgetType;
  title: string;
  config: DashboardWidgetConfig;
  layout: DashboardWidgetLayout;
};

const NOTE = `# What to watch

- **Pending rows** and **oldest pending age** are the primary scaling signals. Healthy ingest drains both back down; a steady climb means the worker is falling behind incoming telemetry.
- **Cursor lag** should stay bounded. Rising lag means ClickHouse is receiving data faster than this worker can fingerprint it.
- **Batch-full events** should be rare. If they keep firing while pending rows or age rises, the worker is outscaled by telemetry volume.
- **Batch duration p95** should stay comfortably below the tick interval. If it climbs first, fingerprinting, issue upserts, or transition handlers are the bottleneck.
- Compare the **span** and **log** series to see which ingest path needs tuning or isolation.`;

function metric(
  title: string,
  metricName: string,
  opts: {
    aggregation?: DashboardWidgetConfig["aggregation"];
    chartType?: "line" | "bar";
    legend?: boolean;
  } = {},
): Omit<WidgetSpec, "layout"> {
  return {
    type: "timeseries_metric",
    title,
    config: {
      source: "logs",
      filter: {},
      metricName,
      groupBy: "attr:telemetry.kind",
      aggregation: opts.aggregation,
      chartType: opts.chartType ?? "line",
      showXAxis: true,
      showYAxis: true,
      showLegend: opts.legend ?? true,
    },
  };
}

const widgets: WidgetSpec[] = [
  {
    type: "markdown",
    title: "How to read this dashboard",
    config: { filter: {}, markdown: NOTE },
    layout: { x: 0, y: 0, w: 4, h: 7 },
  },
  {
    ...metric("Pending rows by kind", "superlog.worker.telemetry.pending_rows"),
    layout: { x: 4, y: 0, w: 4, h: 7 },
  },
  {
    ...metric("Oldest pending age by kind", "superlog.worker.telemetry.oldest_pending_age_ms"),
    layout: { x: 8, y: 0, w: 4, h: 7 },
  },
  {
    ...metric("Cursor lag by kind", "superlog.worker.telemetry.cursor_lag_ms"),
    layout: { x: 0, y: 7, w: 4, h: 7 },
  },
  {
    ...metric("Rows processed by kind", "superlog.worker.telemetry.batch_rows", {
      aggregation: "sum",
      chartType: "bar",
    }),
    layout: { x: 4, y: 7, w: 4, h: 7 },
  },
  {
    ...metric("Batch-full events by kind", "superlog.worker.telemetry.batch_full", {
      aggregation: "sum",
      chartType: "bar",
    }),
    layout: { x: 8, y: 7, w: 4, h: 7 },
  },
  {
    ...metric("Batch duration p95 by kind", "superlog.worker.telemetry.batch_duration_ms", {
      aggregation: "p95",
    }),
    layout: { x: 0, y: 14, w: 6, h: 7 },
  },
  {
    ...metric("Batch duration avg by kind", "superlog.worker.telemetry.batch_duration_ms", {
      aggregation: "avg",
    }),
    layout: { x: 6, y: 14, w: 6, h: 7 },
  },
];

async function pickProjectMemberUserId(projectId: string): Promise<string> {
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
  });
  if (!project) throw new Error(`project ${projectId} not found`);
  const member = await db.query.orgMembers.findFirst({
    where: eq(schema.orgMembers.orgId, project.orgId),
  });
  if (!member) throw new Error(`no org member found for org ${project.orgId}`);
  return member.userId;
}

async function main() {
  const { projectId } = parseArgs(process.argv.slice(2));
  const userId = await pickProjectMemberUserId(projectId);

  let dashboard = await db.query.dashboards.findFirst({
    where: and(
      eq(schema.dashboards.projectId, projectId),
      eq(schema.dashboards.slug, DASHBOARD_SLUG),
    ),
  });

  if (!dashboard) {
    const [inserted] = await db
      .insert(schema.dashboards)
      .values({
        projectId,
        name: DASHBOARD_NAME,
        slug: DASHBOARD_SLUG,
        createdBy: userId,
      })
      .returning();
    if (!inserted) throw new Error("dashboard insert returned no row");
    dashboard = inserted;
    console.log(`created dashboard ${dashboard.id} (${DASHBOARD_NAME})`);
  } else {
    console.log(`found existing dashboard ${dashboard.id} (${DASHBOARD_NAME})`);
  }

  const dashboardId = dashboard.id;
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.dashboardId, dashboardId));

    for (const [i, w] of widgets.entries()) {
      await tx.insert(schema.dashboardWidgets).values({
        dashboardId,
        type: w.type,
        title: w.title,
        config: w.config,
        layout: w.layout,
        position: i,
      });
    }

    await tx
      .update(schema.dashboards)
      .set({ updatedAt: new Date() })
      .where(eq(schema.dashboards.id, dashboardId));
  });

  console.log(`seeded ${widgets.length} widgets`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
