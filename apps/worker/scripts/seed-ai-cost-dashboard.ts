// Seeds the "AI Cost" dashboard in a Superlog project. Idempotent: replaces
// widgets on the existing slug if the dashboard is already there.
//
// Usage (against prod via Railway):
//   railway run --service worker pnpm tsx scripts/seed-ai-cost-dashboard.ts \
//     --project-id b925b1df-5b78-43c8-a816-6f00afb174af
//
// Locally against the worktree DB:
//   pnpm tsx scripts/seed-ai-cost-dashboard.ts --project-id <uuid>
import "../src/env.js";
import {
  db,
  schema,
  type DashboardWidgetConfig,
  type DashboardWidgetLayout,
  type DashboardWidgetType,
} from "@superlog/db";
import { and, eq } from "drizzle-orm";

function parseArgs(argv: string[]): { projectId: string } {
  const idx = argv.indexOf("--project-id");
  if (idx === -1 || !argv[idx + 1]) {
    throw new Error("--project-id <uuid> is required");
  }
  return { projectId: argv[idx + 1] };
}

const DASHBOARD_SLUG = "ai-cost";
const DASHBOARD_NAME = "AI Cost";

type WidgetSpec = {
  type: DashboardWidgetType;
  title: string;
  config: DashboardWidgetConfig;
  layout: DashboardWidgetLayout;
};

// 12-column grid (per dashboardWidgetLayoutSchema, x/w up to 48 but the web
// renders 12 columns by convention).
//
// Helper to keep widget definitions compact. `source: "logs"` is required by
// the zod schema but unused for metric-series widgets.
function metric(
  title: string,
  metricName: string,
  opts: {
    groupBy?: string;
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
      ...(opts.groupBy ? { groupBy: opts.groupBy } : {}),
      chartType: opts.chartType ?? "line",
      showLegend: opts.legend ?? true,
    },
  };
}

// Lays widgets out left-to-right, wrapping rows of equal-height widgets. Pass
// width per widget — heights all become `h` and rows track `y` automatically.
function gridify(rows: Array<{ h: number; cells: Array<{ w: number; spec: Omit<WidgetSpec, "layout"> }> }>): WidgetSpec[] {
  const out: WidgetSpec[] = [];
  let y = 0;
  for (const row of rows) {
    let x = 0;
    for (const cell of row.cells) {
      out.push({ ...cell.spec, layout: { x, y, w: cell.w, h: row.h } });
      x += cell.w;
    }
    y += row.h;
  }
  return out;
}

const widgets: WidgetSpec[] = gridify([
  // Headline: the one number we care about most.
  {
    h: 8,
    cells: [{ w: 12, spec: metric("Total AI cost (USD) over time", "superlog.ai.cost_usd") }],
  },
  // Who's costing us money, and where is the spend going?
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("Cost (USD) by customer org", "superlog.ai.cost_usd", { groupBy: "attr:tenant.org.id" }) },
      { w: 6, spec: metric("Cost (USD) by call site", "superlog.ai.cost_usd", { groupBy: "attr:superlog.call_site", chartType: "bar" }) },
    ],
  },
  // Model mix — are opus calls leaking where they shouldn't?
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("Cost (USD) by model", "superlog.ai.cost_usd", { groupBy: "attr:gen_ai.request.model", chartType: "bar" }) },
      { w: 6, spec: metric("Cost (USD) by outcome", "superlog.ai.cost_usd", { groupBy: "attr:superlog.outcome", chartType: "bar" }) },
    ],
  },
  // PR yield. If we're spending big on agent_runs that don't produce a
  // PR, that's the lowest-ROI bucket and the first thing to tune.
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("Cost (USD) by has_pr", "superlog.ai.cost_usd", { groupBy: "attr:superlog.has_pr", chartType: "bar" }) },
      { w: 6, spec: metric("AgentRuns by outcome (count)", "superlog.ai.agent_run_count", { groupBy: "attr:superlog.outcome", chartType: "bar" }) },
    ],
  },
  // Volume slicing.
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("AgentRuns by customer org (count)", "superlog.ai.agent_run_count", { groupBy: "attr:tenant.org.id", chartType: "bar" }) },
      { w: 6, spec: metric("AgentRuns by call site (count)", "superlog.ai.agent_run_count", { groupBy: "attr:superlog.call_site", chartType: "bar" }) },
    ],
  },
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("AgentRuns by model (count)", "superlog.ai.agent_run_count", { groupBy: "attr:gen_ai.request.model", chartType: "bar" }) },
      { w: 6, spec: metric("AgentRuns by has_pr (count)", "superlog.ai.agent_run_count", { groupBy: "attr:superlog.has_pr", chartType: "bar" }) },
    ],
  },
  // Token deep-dive — what's driving the cost line.
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("Input tokens by customer org", "superlog.ai.input_tokens", { groupBy: "attr:tenant.org.id" }) },
      { w: 6, spec: metric("Output tokens by customer org", "superlog.ai.output_tokens", { groupBy: "attr:tenant.org.id" }) },
    ],
  },
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("Cache-read tokens by call site", "superlog.ai.cache_read_tokens", { groupBy: "attr:superlog.call_site" }) },
      { w: 6, spec: metric("Cache-write tokens by call site", "superlog.ai.cache_write_tokens", { groupBy: "attr:superlog.call_site" }) },
    ],
  },
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("Input tokens by call site", "superlog.ai.input_tokens", { groupBy: "attr:superlog.call_site" }) },
      { w: 6, spec: metric("Output tokens by call site", "superlog.ai.output_tokens", { groupBy: "attr:superlog.call_site" }) },
    ],
  },
  // Time. Managed-agent active_seconds is what Anthropic charges us per
  // session, separate from token cost. Long sessions = lots of bash/edit/grep
  // loops — a useful signal even when token cost looks fine.
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("Managed-agent seconds by customer org", "superlog.ai.agent_run_seconds", { groupBy: "attr:tenant.org.id" }) },
      { w: 6, spec: metric("Managed-agent seconds by call site", "superlog.ai.agent_run_seconds", { groupBy: "attr:superlog.call_site" }) },
    ],
  },
  {
    h: 8,
    cells: [
      { w: 6, spec: metric("Managed-agent seconds by outcome", "superlog.ai.agent_run_seconds", { groupBy: "attr:superlog.outcome" }) },
      // model.pricing_fallback=true means we billed a model the pricing table
      // didn't recognize (so we fell back to sonnet prices). Anything showing
      // up here means we need to add that model to the pricing table.
      { w: 6, spec: metric("Cost (USD) with pricing-fallback flag", "superlog.ai.cost_usd", { groupBy: "attr:model.pricing_fallback", chartType: "bar" }) },
    ],
  },
]);

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

  // Replace widgets atomically: delete + re-insert in one transaction so a
  // mid-run crash doesn't leave the dashboard empty until someone re-runs.
  const dashboardId = dashboard.id;
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.dashboardId, dashboardId));

    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i]!;
      await tx.insert(schema.dashboardWidgets).values({
        dashboardId,
        type: w.type,
        title: w.title,
        config: w.config as DashboardWidgetConfig,
        layout: w.layout,
        position: i,
      });
    }
  });
  console.log(`seeded ${widgets.length} widgets`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
