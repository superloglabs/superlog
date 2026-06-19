// Provision the shared demo project that powers demo mode.
//
// Demo mode (see apps/api/src/demo.ts) lets a brand-new user explore a populated
// product before instrumenting anything: until their own project ingests, the
// API serves them THIS project's data, read-only. This script creates that
// project and seeds a curated, hand-written set of incidents (with agent-style
// root-cause writeups) + dashboards. Live telemetry is layered on separately by
// the worker's demo-feed job (apps/worker/src/jobs/demo-feed.ts), which keeps
// traces/logs/metrics flowing so charts move and the explorer stays populated.
//
// The project is hidden from real users by having NO org_members on its org —
// resolveActiveOrgContext gates on membership, so nobody can navigate to it; the
// overlay reads it server-side by id only. Print the resulting project id and
// set it as DEMO_PROJECT_ID on the api + worker.
//
// Idempotent. Pass --reset to wipe previously-seeded demo data before reseeding.
//
//   DATABASE_URL=... pnpm tsx scripts/demo/provision-demo-project.ts [--reset]

import process from "node:process";
import { and, eq, like } from "drizzle-orm";

const DEMO = {
  ownerEmail: "demo@superlog.internal",
  orgName: "Acme (demo)",
  orgSlug: "acme-demo",
  projectName: "Acme Storefront",
  projectSlug: "acme-storefront",
};

// Curated incidents. Each gets one linked issue. The "investigation" the user
// reads is the agentSummary / rootCause / impact text on the incident row —
// exactly where the worker writes real agent findings.
type SeedIncident = {
  codename: string;
  service: string;
  environment: string;
  title: string;
  severity: "SEV-1" | "SEV-2" | "SEV-3";
  status: "open" | "resolved";
  ageDays: number; // firstSeen = now - ageDays
  agentSummary: string;
  rootCauseText: string;
  estimatedImpactText: string;
  exceptionType: string;
  topFrame: string;
  eventCount: number;
};

const INCIDENTS: SeedIncident[] = [
  {
    codename: "amber-otter",
    service: "payments-api",
    environment: "production",
    title: "Checkout 500s on payment capture",
    severity: "SEV-1",
    status: "open",
    ageDays: 0,
    agentSummary:
      "A null `paymentIntent.customer` reaches `capturePayment()` for guest checkouts, throwing before the charge is created. ~6% of checkouts affected since the 14:20 deploy.",
    rootCauseText:
      "The guest-checkout path skips customer creation, so `customer` is undefined. `capturePayment()` dereferences `customer.defaultSource` without a guard (payments-api/src/capture.ts:88).",
    estimatedImpactText:
      "≈ 6% of checkout attempts (guest users) failing. Revenue impact rising with evening traffic.",
    exceptionType: "TypeError",
    topFrame: "capturePayment (payments-api/src/capture.ts:88:17)",
    eventCount: 412,
  },
  {
    codename: "brisk-finch",
    service: "catalog-api",
    environment: "production",
    title: "Product search p95 latency spike",
    severity: "SEV-2",
    status: "open",
    ageDays: 1,
    agentSummary:
      "Search p95 jumped from 180ms to 1.4s. A missing index on `products.search_vector` forces a sequential scan under the new fuzzy-match query.",
    rootCauseText:
      "The fuzzy-search feature shipped without the GIN index on `search_vector`; Postgres falls back to a seq scan on the 2.1M-row products table.",
    estimatedImpactText: "All search requests slow; visible cart-abandonment uptick on mobile.",
    exceptionType: "SlowQueryWarning",
    topFrame: "searchProducts (catalog-api/src/search.ts:54:11)",
    eventCount: 88,
  },
  {
    codename: "calm-heron",
    service: "checkout-api",
    environment: "production",
    title: "Cart total wrong for stacked discounts",
    severity: "SEV-2",
    status: "resolved",
    ageDays: 4,
    agentSummary:
      "When two percentage discounts stacked, they were applied additively instead of multiplicatively, undercharging by up to 12%. Fixed and deployed.",
    rootCauseText:
      "`applyDiscounts()` summed discount rates rather than composing them. Corrected to fold sequentially (checkout-api/src/pricing.ts:120).",
    estimatedImpactText: "~340 orders undercharged over 2 days before the fix.",
    exceptionType: "AssertionError",
    topFrame: "applyDiscounts (checkout-api/src/pricing.ts:120:9)",
    eventCount: 51,
  },
  {
    codename: "dapper-lynx",
    service: "web",
    environment: "production",
    title: "Intermittent 404s on product images",
    severity: "SEV-3",
    status: "open",
    ageDays: 2,
    agentSummary:
      "A CDN cache-key change drops the `?v=` asset hash for ~3% of image URLs, yielding sporadic 404s on first load.",
    rootCauseText:
      "The image proxy strips query strings it doesn't recognize; the new versioned-asset param isn't in its allowlist (web/src/img-proxy.ts:33).",
    estimatedImpactText: "Cosmetic; broken thumbnails on a small fraction of product cards.",
    exceptionType: "NotFoundError",
    topFrame: "resolveAsset (web/src/img-proxy.ts:33:5)",
    eventCount: 73,
  },
  {
    codename: "eager-marten",
    service: "payments-api",
    environment: "production",
    title: "Duplicate charges on network retry",
    severity: "SEV-1",
    status: "resolved",
    ageDays: 6,
    agentSummary:
      "A client retry on timeout created a second charge because the idempotency key was regenerated per attempt. Now derived from the order id. Resolved.",
    rootCauseText:
      "Idempotency key used a per-request UUID; retries got fresh keys. Switched to `order:<id>:capture` (payments-api/src/capture.ts:142).",
    estimatedImpactText: "29 customers double-charged before mitigation; all refunded.",
    exceptionType: "DuplicateChargeError",
    topFrame: "capturePayment (payments-api/src/capture.ts:142:13)",
    eventCount: 31,
  },
  {
    codename: "fleet-osprey",
    service: "worker",
    environment: "production",
    title: "Inventory sync job timing out",
    severity: "SEV-3",
    status: "open",
    ageDays: 3,
    agentSummary:
      "The nightly inventory sync exceeds its 5-minute budget as the supplier feed grew; the job is killed mid-batch, leaving stock counts stale.",
    rootCauseText:
      "Sync fetches all SKUs in one request and processes serially. Needs pagination + batched upserts (worker/src/jobs/inventory-sync.ts:61).",
    estimatedImpactText: "Stock levels up to a day stale for ~8% of SKUs.",
    exceptionType: "TimeoutError",
    topFrame: "syncInventory (worker/src/jobs/inventory-sync.ts:61:7)",
    eventCount: 12,
  },
];

// Two dashboards over the metric names the demo-feed job emits, grouped by
// service. NB groupBy must be "service.name" (resolves to ServiceName); the
// older seeders used "resource:service.name" which looks up a non-existent key.
const DASHBOARDS = [
  {
    name: "Service overview",
    slug: "service-overview",
    widgets: [
      {
        type: "timeseries_metric" as const,
        title: "Request rate by service",
        config: {
          metricName: "http.server.requests",
          groupBy: "service.name",
          filter: { resourceAttrs: [] as never[] },
        },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
      {
        type: "timeseries_metric" as const,
        title: "Latency (p50) by service",
        config: {
          metricName: "http.server.duration",
          groupBy: "service.name",
          filter: { resourceAttrs: [] as never[] },
        },
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
    ],
  },
  {
    name: "Capacity",
    slug: "capacity",
    widgets: [
      {
        type: "timeseries_metric" as const,
        title: "Memory usage by service",
        config: {
          metricName: "process.memory.usage",
          groupBy: "service.name",
          filter: { resourceAttrs: [] as never[] },
        },
        layout: { x: 0, y: 0, w: 12, h: 4 },
      },
    ],
  },
];

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const [{ db }, schema, agentRuntime] = await Promise.all([
    import("../../packages/db/src/client.js"),
    import("../../packages/db/src/schema.js"),
    import("../../packages/db/src/agent-runtime.js"),
  ]);

  // ── Owner user (created_by for dashboards; never logs in) ────────────────
  let user = await db.query.users.findFirst({ where: eq(schema.users.email, DEMO.ownerEmail) });
  if (!user) {
    user = (await db.insert(schema.users).values({ email: DEMO.ownerEmail }).returning())[0];
  }
  if (!user) throw new Error("failed to provision demo owner user");

  // ── Org (NO org_members — keeps the project invisible to real users) ─────
  let org = await db.query.orgs.findFirst({ where: eq(schema.orgs.slug, DEMO.orgSlug) });
  if (!org) {
    org = (
      await db.insert(schema.orgs).values({ name: DEMO.orgName, slug: DEMO.orgSlug }).returning()
    )[0];
  }
  if (!org) throw new Error("failed to provision demo org");

  // ── Project ──────────────────────────────────────────────────────────────
  let project = await db.query.projects.findFirst({
    where: and(eq(schema.projects.orgId, org.id), eq(schema.projects.slug, DEMO.projectSlug)),
  });
  if (!project) {
    project = (
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: DEMO.projectName, slug: DEMO.projectSlug })
        .returning()
    )[0];
  }
  if (!project) throw new Error("failed to provision demo project");
  const projectId = project.id;

  // ── Automation OFF: no agent runs, no auto-investigation on demo data ─────
  await db
    .insert(schema.projectAutomationSettings)
    .values({
      projectId,
      autoInvestigateIssuesEnabled: false,
      agentRunEnabled: false,
      agentRunProvider: agentRuntime.DEFAULT_AGENT_RUN_PROVIDER,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.projectAutomationSettings.projectId,
      set: { autoInvestigateIssuesEnabled: false, agentRunEnabled: false, updatedAt: new Date() },
    });

  // ── Reset prior demo content ──────────────────────────────────────────────
  if (reset) {
    // incident_issues cascades from incidents; issues are deleted explicitly.
    await db.delete(schema.incidents).where(eq(schema.incidents.projectId, projectId));
    await db
      .delete(schema.issues)
      .where(
        and(
          eq(schema.issues.projectId, projectId),
          like(schema.issues.fingerprint, "demo-incident-%"),
        ),
      );
    await db.delete(schema.dashboards).where(eq(schema.dashboards.projectId, projectId));
    console.log("✓ reset prior demo content");
  }

  // ── Curated incidents + issues ────────────────────────────────────────────
  let incidentCount = 0;
  for (const [i, inc] of INCIDENTS.entries()) {
    const fingerprint = `demo-incident-${i + 1}`;
    const firstSeen = daysAgo(inc.ageDays);
    const lastSeen = inc.status === "resolved" ? daysAgo(Math.max(0, inc.ageDays - 1)) : new Date();

    // Skip if this incident already exists (idempotent without --reset).
    const existing = await db.query.incidents.findFirst({
      where: and(
        eq(schema.incidents.projectId, projectId),
        eq(schema.incidents.codename, inc.codename),
      ),
    });
    if (existing) continue;

    const issue = (
      await db
        .insert(schema.issues)
        .values({
          projectId,
          fingerprint,
          kind: "span",
          service: inc.service,
          exceptionType: inc.exceptionType,
          title: inc.title,
          message: inc.agentSummary,
          topFrame: inc.topFrame,
          firstSeen,
          lastSeen,
          eventCount: inc.eventCount,
        })
        .returning()
    )[0];
    if (!issue) throw new Error(`failed to insert issue for ${inc.codename}`);

    const incidentRow = (
      await db
        .insert(schema.incidents)
        .values({
          projectId,
          service: inc.service,
          environment: inc.environment,
          title: inc.title,
          codename: inc.codename,
          severity: inc.severity,
          status: inc.status,
          firstSeen,
          lastSeen,
          issueCount: 1,
          agentSummary: inc.agentSummary,
          rootCauseText: inc.rootCauseText,
          rootCauseConfidence: 80,
          estimatedImpactText: inc.estimatedImpactText,
          estimatedImpactConfidence: 70,
          ...(inc.status === "resolved"
            ? {
                resolvedAt: lastSeen,
                resolvedByKind: "agent_classification" as const,
                resolvedReasonCode: "fixed_in_current_code",
                resolvedReasonText: "Fix deployed; no recurrence since.",
              }
            : {}),
        })
        .returning()
    )[0];
    if (!incidentRow) throw new Error(`failed to insert incident ${inc.codename}`);

    await db
      .insert(schema.incidentIssues)
      .values({ incidentId: incidentRow.id, issueId: issue.id });
    incidentCount++;
  }

  // ── Dashboards + widgets ──────────────────────────────────────────────────
  for (const d of DASHBOARDS) {
    let dashboard = await db.query.dashboards.findFirst({
      where: and(eq(schema.dashboards.projectId, projectId), eq(schema.dashboards.slug, d.slug)),
    });
    if (!dashboard) {
      dashboard = (
        await db
          .insert(schema.dashboards)
          .values({ projectId, name: d.name, slug: d.slug, createdBy: user.id })
          .returning()
      )[0];
    }
    if (!dashboard) throw new Error(`failed to insert dashboard ${d.slug}`);
    const dashboardId = dashboard.id;
    await db
      .delete(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.dashboardId, dashboardId));
    await db.insert(schema.dashboardWidgets).values(
      d.widgets.map((w, i) => ({
        dashboardId,
        type: w.type,
        title: w.title,
        config: w.config,
        layout: w.layout,
        position: i,
      })),
    );
  }

  console.log(
    JSON.stringify(
      {
        demoProjectId: projectId,
        org: { id: org.id, slug: DEMO.orgSlug },
        seeded: { incidents: incidentCount, dashboards: DASHBOARDS.length },
        next: "Set DEMO_PROJECT_ID=<demoProjectId> on api + worker, and DEMO_COLLECTOR_URL on worker.",
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
