import { db, schema } from "@superlog/db";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { isReadOnlyPostPath } from "./request-actor-log.js";

// ---------------------------------------------------------------------------
// Demo data overlay
//
// A brand-new user whose project has never ingested telemetry transparently
// READS a single shared, hidden demo project's data (incidents, dashboards,
// traces, logs, metrics) so they can evaluate the product before instrumenting
// their own app. The substitution is server-side and read-only:
//
//   effectiveReadProjectId = hasData ? realProjectId : DEMO_PROJECT_ID
//
// The moment real telemetry lands or a Sentry issue reaches the durable inbox,
// a project-level marker flips and every read switches back to their project.
//
// The whole feature is gated on the DEMO_PROJECT_ID env var. When unset (the
// open-core / self-host default) every helper below is a no-op and behaviour is
// exactly as before — no extra queries, no overlay.
// ---------------------------------------------------------------------------

type Vars = {
  userId: string;
  orgId: string | null;
  // Set by the demoOverlay middleware: the project id reads should target for
  // this request (the demo project when overlaying, else the real id). Lets
  // requireProjectAccess reuse the decision instead of recomputing it.
  demoReadProjectId?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The configured shared demo project id, or undefined when demo mode is off.
 * Requires a canonical UUID: a misconfigured (wrong-length / typo) value
 * disables demo mode rather than risking a malformed response rewrite — the
 * fail-safe direction.
 */
export function demoProjectId(): string | undefined {
  const id = process.env.DEMO_PROJECT_ID?.trim();
  return id && UUID_RE.test(id) ? id : undefined;
}

/**
 * Pure decision: which project id should the read path query, and is this an
 * overlay read? We never substitute when the caller IS the demo project or
 * once the real project has telemetry or Sentry issue data.
 */
export function pickReadProjectId(args: {
  realProjectId: string;
  demoProjectId: string | undefined;
  hasData: boolean;
}): { id: string; demo: boolean } {
  const { realProjectId, demoProjectId, hasData } = args;
  if (demoProjectId && !hasData && demoProjectId !== realProjectId) {
    return { id: demoProjectId, demo: true };
  }
  return { id: realProjectId, demo: false };
}

/**
 * Has this project ever ingested telemetry? Prefer the project-level acceptance
 * marker, which also covers vendor-authenticated paths without a project API
 * key. Keep last_used_at as a compatibility fallback for projects activated
 * before first_telemetry_at existed.
 */
export async function projectHasIngested(projectId: string): Promise<boolean> {
  return (await projectDataStatus(projectId)).hasIngested;
}

export function projectHasOnboardingData(status: {
  hasIngested: boolean;
  hasSentryIssues: boolean;
}): boolean {
  return status.hasIngested || status.hasSentryIssues;
}

export async function projectDataStatus(projectId: string): Promise<{
  hasIngested: boolean;
  hasSentryIssues: boolean;
}> {
  const project = await db.query.projects.findFirst({
    columns: { firstTelemetryAt: true, firstSentryIssueAt: true },
    where: eq(schema.projects.id, projectId),
  });
  let hasIngested = project?.firstTelemetryAt !== null && project?.firstTelemetryAt !== undefined;
  if (!hasIngested) {
    const row = await db.query.apiKeys.findFirst({
      columns: { id: true },
      where: and(eq(schema.apiKeys.projectId, projectId), isNotNull(schema.apiKeys.lastUsedAt)),
    });
    hasIngested = row !== undefined;
  }
  return {
    hasIngested,
    hasSentryIssues:
      project?.firstSentryIssueAt !== null && project?.firstSentryIssueAt !== undefined,
  };
}

export async function projectHasData(projectId: string): Promise<boolean> {
  return projectHasOnboardingData(await projectDataStatus(projectId));
}

/**
 * Resolve the effective read project id for a real project. Returns the real id
 * untouched (and skips the hasIngested query entirely) when demo mode is off.
 */
export async function resolveEffectiveReadProjectId(
  realProjectId: string,
): Promise<{ id: string; demo: boolean }> {
  const demo = demoProjectId();
  if (!demo || demo === realProjectId) return { id: realProjectId, demo: false };
  const hasData = await projectHasData(realProjectId);
  return pickReadProjectId({ realProjectId, demoProjectId: demo, hasData });
}

/** Is this project currently served demo data? (demo configured && no real data) */
export async function isProjectInDemoMode(realProjectId: string): Promise<boolean> {
  return (await resolveEffectiveReadProjectId(realProjectId)).demo;
}

// ---------------------------------------------------------------------------
// Read-only enforcement (framework level)
// ---------------------------------------------------------------------------

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Demo-overlaid resources are read-only while a project is in demo mode. We use
// an explicit set rather than "block every mutating method" because several
// READ endpoints are POST (they carry query filters in the body) — blocking
// those would break the demo trace/log/metric explorer. Equally, the install /
// integration path (keys, automation, cloud-connections, webhooks, slack-route,
// symbolication) must stay OPEN — minting an ingest key and connecting an app
// are exactly how a user leaves demo mode.
const READ_ONLY_SEGMENTS = new Set(["dashboards", "incidents", "alerts", "issues"]);

/**
 * Pure: should this request be rejected as a write against demo-overlaid data?
 * Only true for mutating methods targeting a demo-overlaid resource, excluding
 * the POST-for-read endpoints (shared with the mutation audit). Callers still
 * gate this on actual demo mode.
 */
export function isDemoBlockedWrite(args: { method: string; path: string }): boolean {
  if (!MUTATING_METHODS.has(args.method.toUpperCase())) return false;
  if (isReadOnlyPostPath(args.path)) return false;
  const sub = args.path.match(/^\/api\/projects\/[^/]+\/(.+?)(?:\?.*)?$/)?.[1];
  if (!sub) return false;
  return READ_ONLY_SEGMENTS.has(sub.split("/")[0] ?? "");
}

/**
 * Hono middleware for the demo overlay. Mount on `/api/projects/:projectId/*`.
 * It is the single place the per-request overlay decision is made:
 *  - decides whether this project is currently served demo data (one cheap
 *    hasIngested lookup) and stashes the read target in `c.var.demoReadProjectId`
 *    so requireProjectAccess can reuse it;
 *  - enforces read-only by rejecting writes to demo-overlaid resources (403);
 *  - rewrites the demo project id back to the real one in the JSON response, so
 *    the client never sees the demo id and routes sub-resource calls (incident
 *    stats, PRs, …) to its own project (which re-overlays server-side). Both ids
 *    are 36-char UUIDs, so Content-Length stays valid.
 * No-op (and no extra query) when DEMO_PROJECT_ID is unset.
 */
export function demoOverlay() {
  return createMiddleware<{ Variables: Vars }>(async (c: Context<{ Variables: Vars }>, next) => {
    const demo = demoProjectId();
    const realProjectId = c.req.param("projectId");
    if (!demo || !realProjectId || realProjectId === demo) {
      await next();
      return;
    }

    const overlaying = !(await projectHasData(realProjectId));
    c.set("demoReadProjectId", overlaying ? demo : realProjectId);

    if (overlaying && isDemoBlockedWrite({ method: c.req.method, path: c.req.path })) {
      throw new HTTPException(403, { message: "demo_read_only" });
    }

    await next();

    if (!overlaying) return;
    const res = c.res;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return;
    try {
      // Read from a clone so the original body is never disturbed if we bail.
      const body = await res.clone().text();
      if (!body.includes(demo)) return;
      const headers = new Headers(res.headers);
      // Let the runtime recompute the length. demo→real are equal-length UUIDs
      // so it's unchanged today, but not coupling to that keeps the rewrite
      // robust if the body length ever shifts.
      headers.delete("content-length");
      c.res = new Response(body.split(demo).join(realProjectId), {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    } catch {
      // Rewriting is best-effort; never let it turn a good response into a 500.
    }
  });
}
