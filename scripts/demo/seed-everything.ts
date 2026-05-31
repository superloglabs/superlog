// Seed a worktree's project with everything you need to refine the UI:
// telemetry (logs/traces/metrics), auto-generated issues + incidents
// (the worker picks them up from CH), a couple of dashboards with widgets
// pointed at the seeded metrics, and a handful of alert definitions.
//
// Idempotent. Safe to re-run; widgets get wiped + reseeded so this script
// is the source of truth for the seeded layout.
//
//   DATABASE_URL=postgres://postgres:postgres@localhost:5434/superlog_<slug> \
//     pnpm tsx scripts/demo/seed-everything.ts \
//     [--project-id <uuid>] [--user-id <uuid>] \
//     [--collector-url http://localhost:4318] \
//     [--minutes 180] [--points 60] [--services 5] \
//     [--skip-telemetry]
//
// If --project-id / --user-id are omitted, the script picks the first project
// in the DB and the first user with org membership. Useful for worktree DBs
// that already went through `demo:bootstrap:acme`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";

type Args = {
  projectId: string | null;
  userId: string | null;
  collectorUrl: string;
  minutes: number;
  points: number;
  services: number;
  skipTelemetry: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    projectId: null,
    userId: null,
    collectorUrl: "http://localhost:4318",
    minutes: 180,
    points: 60,
    services: 5,
    skipTelemetry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--project-id":
        out.projectId = next();
        break;
      case "--user-id":
        out.userId = next();
        break;
      case "--collector-url":
        out.collectorUrl = next();
        break;
      case "--minutes":
        out.minutes = Number(next());
        break;
      case "--points":
        out.points = Number(next());
        break;
      case "--services":
        out.services = Number(next());
        break;
      case "--skip-telemetry":
        out.skipTelemetry = true;
        break;
      case "--":
        break;
      case "-h":
      case "--help":
        console.log(
          "usage: seed-everything.ts [--project-id uuid] [--user-id uuid] [--collector-url url] [--minutes n] [--points n] [--services n] [--skip-telemetry]",
        );
        process.exit(0);
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: help exits
      default:
        if (a?.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

type WidgetSpec = {
  type: "timeseries_metric";
  title: string;
  config: { metricName: string; groupBy: string | null; filter: { resourceAttrs: never[] } };
  layout: { x: number; y: number; w: number; h: number };
};

const APP_OVERVIEW_WIDGETS: WidgetSpec[] = [
  {
    type: "timeseries_metric",
    title: "Requests per service",
    config: {
      metricName: "http.server.requests",
      groupBy: "resource:service.name",
      filter: { resourceAttrs: [] },
    },
    layout: { x: 0, y: 0, w: 6, h: 6 },
  },
  {
    type: "timeseries_metric",
    title: "Errors per service",
    config: {
      metricName: "http.server.errors",
      groupBy: "resource:service.name",
      filter: { resourceAttrs: [] },
    },
    layout: { x: 6, y: 0, w: 6, h: 6 },
  },
  {
    type: "timeseries_metric",
    title: "p95 latency by service",
    config: {
      metricName: "http.server.duration",
      groupBy: "resource:service.name",
      filter: { resourceAttrs: [] },
    },
    layout: { x: 0, y: 6, w: 12, h: 6 },
  },
];

const ERRORS_LATENCY_WIDGETS: WidgetSpec[] = [
  {
    type: "timeseries_metric",
    title: "HTTP errors (all services)",
    config: {
      metricName: "http.server.errors",
      groupBy: null,
      filter: { resourceAttrs: [] },
    },
    layout: { x: 0, y: 0, w: 12, h: 6 },
  },
  {
    type: "timeseries_metric",
    title: "Latency by service",
    config: {
      metricName: "http.server.duration",
      groupBy: "resource:service.name",
      filter: { resourceAttrs: [] },
    },
    layout: { x: 0, y: 6, w: 12, h: 6 },
  },
];

const DASHBOARDS: Array<{ name: string; slug: string; widgets: WidgetSpec[] }> = [
  { name: "App overview", slug: "app-overview", widgets: APP_OVERVIEW_WIDGETS },
  { name: "Errors and latency", slug: "errors-latency", widgets: ERRORS_LATENCY_WIDGETS },
];

const ALERTS = [
  {
    name: "High HTTP 5xx error rate",
    source: "metric" as const,
    metricName: "http.server.errors",
    aggregation: "avg" as const,
    comparator: ">" as const,
    threshold: 5,
    windowMinutes: 5,
    groupMode: "single" as const,
  },
  {
    name: "Latency spike (p95 > 500ms)",
    source: "metric" as const,
    metricName: "http.server.duration",
    aggregation: "p95" as const,
    comparator: ">" as const,
    threshold: 500,
    windowMinutes: 10,
    groupMode: "single" as const,
  },
  {
    name: "Error log surge",
    source: "log" as const,
    metricName: null,
    filter: { severity: "ERROR" },
    aggregation: "count" as const,
    comparator: ">" as const,
    threshold: 50,
    windowMinutes: 15,
    groupMode: "single" as const,
  },
  {
    name: "CPU saturation per service",
    source: "metric" as const,
    metricName: "system.cpu.utilization",
    aggregation: "avg" as const,
    comparator: ">" as const,
    threshold: 0.8,
    windowMinutes: 5,
    groupMode: "group_by" as const,
  },
  {
    name: "Trace volume drop",
    source: "metric" as const,
    metricName: "http.server.requests",
    aggregation: "sum" as const,
    comparator: "<" as const,
    threshold: 100,
    windowMinutes: 10,
    groupMode: "single" as const,
  },
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const args = parseArgs(process.argv.slice(2));

  const [{ db }, schema] = await Promise.all([
    import("../../packages/db/src/client.js"),
    import("../../packages/db/src/schema.js"),
  ]);

  // ── Resolve project + user ────────────────────────────────────────────
  let project = args.projectId
    ? await db.query.projects.findFirst({ where: eq(schema.projects.id, args.projectId) })
    : await db.query.projects.findFirst();
  if (!project) {
    throw new Error("no project found in DB — run pnpm demo:bootstrap:acme first");
  }

  let user = args.userId
    ? await db.query.users.findFirst({ where: eq(schema.users.id, args.userId) })
    : await db.query.users.findFirst();
  if (!user) {
    throw new Error("no user found in DB");
  }

  console.log(`seeding project=${project.id} (${project.name}) as user=${user.email}`);

  // ── Telemetry ─────────────────────────────────────────────────────────
  if (!args.skipTelemetry) {
    console.log(`→ telemetry (collector=${args.collectorUrl}, ${args.minutes}m × ${args.points}pts × ${args.services} services)`);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const richScript = path.join(here, "seed-rich-telemetry.ts");
    const r = spawnSync(
      "pnpm",
      [
        "tsx",
        richScript,
        "--project-id",
        project.id,
        "--collector-url",
        args.collectorUrl,
        "--minutes",
        String(args.minutes),
        "--points",
        String(args.points),
        "--services",
        String(args.services),
      ],
      { stdio: "inherit", env: process.env },
    );
    if (r.status !== 0) throw new Error("rich telemetry seeding failed");
  } else {
    console.log("→ telemetry skipped");
  }

  // ── Dashboards + widgets ──────────────────────────────────────────────
  for (const d of DASHBOARDS) {
    let dashboard = await db.query.dashboards.findFirst({
      where: and(
        eq(schema.dashboards.projectId, project.id),
        eq(schema.dashboards.slug, d.slug),
      ),
    });
    if (!dashboard) {
      const inserted = await db
        .insert(schema.dashboards)
        .values({
          projectId: project.id,
          name: d.name,
          slug: d.slug,
          createdBy: user.id,
        })
        .returning();
      dashboard = inserted[0];
      if (!dashboard) throw new Error(`failed to insert dashboard ${d.slug}`);
    }

    await db
      .delete(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.dashboardId, dashboard.id));
    await db.insert(schema.dashboardWidgets).values(
      d.widgets.map((w, i) => ({
        dashboardId: dashboard!.id,
        type: w.type,
        title: w.title,
        config: w.config,
        layout: w.layout,
        position: i,
      })),
    );
    await db
      .update(schema.dashboards)
      .set({ updatedAt: new Date() })
      .where(eq(schema.dashboards.id, dashboard.id));
    console.log(`✓ dashboard ${d.name} (${d.widgets.length} widgets)`);
  }

  // ── Alerts ────────────────────────────────────────────────────────────
  const existingAlerts = await db.query.alerts.findMany({
    where: eq(schema.alerts.projectId, project.id),
  });
  const existingByName = new Set(existingAlerts.map((a) => a.name));
  const toInsert = ALERTS.filter((a) => !existingByName.has(a.name));
  if (toInsert.length > 0) {
    await db.insert(schema.alerts).values(
      toInsert.map((a) => ({
        projectId: project!.id,
        name: a.name,
        source: a.source,
        metricName: a.metricName,
        filter: ("filter" in a ? a.filter : {}) as Record<string, unknown>,
        aggregation: a.aggregation,
        comparator: a.comparator,
        threshold: a.threshold,
        windowMinutes: a.windowMinutes,
        groupMode: a.groupMode,
        createdBy: user!.id,
      })),
    );
  }
  console.log(`✓ alerts (${toInsert.length} new, ${existingByName.size} already there)`);

  // ── Counts ────────────────────────────────────────────────────────────
  const [issuesCount, incidentsCount, dashboardsCount, alertsCount] = await Promise.all([
    db.query.issues.findMany({ where: eq(schema.issues.projectId, project.id) }).then((r) => r.length),
    db.query.incidents.findMany({ where: eq(schema.incidents.projectId, project.id) }).then((r) => r.length),
    db.query.dashboards.findMany({ where: eq(schema.dashboards.projectId, project.id) }).then((r) => r.length),
    db.query.alerts.findMany({ where: eq(schema.alerts.projectId, project.id) }).then((r) => r.length),
  ]);

  console.log("");
  console.log("done. summary:");
  console.log(`  issues:     ${issuesCount}`);
  console.log(`  incidents:  ${incidentsCount}`);
  console.log(`  dashboards: ${dashboardsCount}`);
  console.log(`  alerts:     ${alertsCount}`);
  console.log("");
  console.log("issues + incidents are produced by the worker tailing CH; if 0,");
  console.log("re-run after the worker has had ~5s to pick up the seeded telemetry.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
