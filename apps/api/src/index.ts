import "./env.js";
import "./net.js";
import { createClient } from "@clickhouse/client";
import { serve } from "@hono/node-server";
import { Autumn } from "autumn-js";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  DEFAULT_AGENT_RUN_PROVIDER,
  type Issue,
  confirmResolutionProposal,
  createIncidentLifecycle,
  db,
  dismissResolutionProposal,
  isAgentRunProvider,
  listAccessibleGithubInstallsForProject,
  mintApiKey,
  resolveIncident,
  runMigrations,
  schema,
  sendLoopsWelcomeFlow,
  upsertLoopsContact,
} from "@superlog/db";
import { fingerprint, fingerprintLog } from "@superlog/fingerprint";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { nanoid } from "nanoid";
import { mountAdmin, userIsStaff } from "./admin.js";
import { mountAlerts } from "./alerts.js";
import { auth } from "./auth.js";
import { shouldRunMigrationsOnBoot } from "./boot-migrations.js";
import { mountDashboards } from "./dashboards.js";
import { mountFeedbackAuthed, mountFeedbackPublic } from "./feedback.js";
import { type GatewayVars, mountGateway } from "./gateway.js";
import { mountGithubAuthed, mountGithubAuthorOAuth, mountGithubPublic } from "./github.js";
import { createApiHttpObservabilityMiddleware } from "./http-observability.js";
import { buildIncidentListItem, shouldInlineIncidentListStats } from "./incidents/list.js";
import { getPrDeliveryRetryEligibility } from "./incidents/pr-retry.js";
import {
  buildIncidentStatsFromActivityRows,
  buildIncidentStatsFromIssues,
  buildIncidentStatsPairs,
  buildIncidentStatsWithFallback,
  spanSampleKey,
} from "./incidents/stats.js";
import { mountLinearAuthed, mountLinearPublic } from "./linear.js";
import { logger } from "./logger.js";
import { mountManagementApi, mountOrgKeyManagementAuthed } from "./management.js";
import {
  METRIC_AGGREGATIONS,
  type MetricAggregation,
  type ResourceAttrFilter,
  type SeriesSource,
  countSeries,
  getTraceDetail,
  listAttributeKeys,
  listAttributeValues,
  listIssueFilterAttributeKeys,
  listIssueFilterAttributeValues,
  listMetricNames,
  listServices,
  metricSeries,
  pickStep,
  previewIssueFilterMatches,
  queryLogs,
  queryMetrics,
  queryTraces,
  queryTracesAggregated,
} from "./mcp/clickhouse.js";
import { mountMcpAuthed, mountMcpPublic } from "./mcp/index.js";
import { resolveActiveOrgContext, resolveMaybeActiveOrgContext } from "./org-context.js";
import { mountSettingsAuthed } from "./settings.js";
import { normalizeSignupIntentKeyHash, normalizeSignupIntentKeyPrefix } from "./signup-intents.js";
import { mountSlackAuthed, mountSlackPublic } from "./slack.js";
import { buildSystemCapabilities } from "./system-capabilities.js";
import { mountWebhooks } from "./webhooks.js";

const PORT = Number(process.env.PORT ?? 4100);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const WEB_CORS_ORIGINS = Array.from(
  new Set([WEB_ORIGIN, "http://localhost:5173", "http://127.0.0.1:5173"]),
);

const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  database: process.env.CLICKHOUSE_DB ?? "superlog",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  // idle_socket_ttl must stay below CH server's keep_alive_timeout (3s default)
  // so we recycle before the server closes; request_timeout short-circuits
  // stale sockets that slipped through instead of hanging 30s.
  request_timeout: 10_000,
  keep_alive: { enabled: true, idle_socket_ttl: 2_500 },
});

const tracer = trace.getTracer("@superlog/api");
const SIGNUP_INTENT_TTL_MS = 30 * 60 * 1000;

type Vars = {
  userId: string;
  orgId: string | null;
  impersonating?: boolean;
} & Partial<GatewayVars>;
const app = new Hono<{ Variables: Vars }>();
const incidentLifecycle = createIncidentLifecycle(db);

app.use(
  "/api/*",
  cors({
    origin: WEB_CORS_ORIGINS,
    credentials: true,
    allowHeaders: [
      "authorization",
      "content-type",
      "traceparent",
      "tracestate",
      "x-superlog-signup-source",
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  }),
);

app.use("/api/*", createApiHttpObservabilityMiddleware());

app.use(
  "/mcp",
  cors({
    origin: "*",
    allowHeaders: ["authorization", "content-type", "mcp-session-id", "mcp-protocol-version"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    exposeHeaders: ["mcp-session-id", "www-authenticate"],
  }),
);

app.use(
  "/oauth/*",
  cors({
    origin: "*",
    allowHeaders: ["content-type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.use(
  "/.well-known/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

app.use(
  "/activate/*",
  cors({
    origin: WEB_CORS_ORIGINS,
    credentials: true,
    allowHeaders: ["authorization", "content-type", "traceparent", "tracestate"],
    allowMethods: ["POST", "OPTIONS"],
  }),
);

// /feedback/pr/* is the anonymous PR-link surface — the web app posts to
// it cross-origin from /feedback/pr/:owner/:repo/:num. Credentials are
// included so a signed-in user is still attributed to their account.
app.use(
  "/feedback/*",
  cors({
    origin: WEB_CORS_ORIGINS,
    credentials: true,
    allowHeaders: ["content-type", "traceparent", "tracestate"],
    allowMethods: ["POST", "OPTIONS"],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

// Tells the web client which social providers have credentials configured
// in this environment so it can hide the buttons that would 503 on click.
app.get("/api/auth-providers", (c) =>
  c.json({
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  }),
);

app.get("/api/system/capabilities", (c) => c.json(buildSystemCapabilities()));

app.post("/api/signup-intents", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    keyHash?: unknown;
    keyPrefix?: unknown;
    returnTo?: unknown;
  };
  const keyHash = normalizeSignupIntentKeyHash(body.keyHash);
  const keyPrefix = normalizeSignupIntentKeyPrefix(body.keyPrefix);
  if (!keyHash || !keyPrefix) {
    throw new HTTPException(400, { message: "valid keyHash and keyPrefix required" });
  }
  const returnTo =
    typeof body.returnTo === "string" && body.returnTo.length <= 1024 ? body.returnTo : null;

  const intentId = `sui_${nanoid(24)}`;
  const expiresAt = new Date(Date.now() + SIGNUP_INTENT_TTL_MS);
  await db.insert(schema.signupIntents).values({
    id: intentId,
    keyHash,
    keyPrefix,
    returnTo,
    expiresAt,
  });

  const signupUrl = new URL(`${WEB_ORIGIN}/signup`);
  signupUrl.searchParams.set("from", "skill");
  signupUrl.searchParams.set("intent", intentId);

  return c.json({
    id: intentId,
    signupUrl: signupUrl.toString(),
    expiresAt: expiresAt.toISOString(),
  });
});

// Better Auth handles its own routes under /api/auth/*. Mount before the
// session middleware so sign-in/sign-up/oauth-callback endpoints don't trip
// the unauthenticated guard.
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

mountGateway(app, ch);
mountGithubPublic(app);
mountGithubAuthorOAuth(app);
mountLinearPublic(app);
mountMcpPublic(app, ch);
mountSlackPublic(app);
mountFeedbackPublic(app);
// Management API (org-key auth, /api/v1/*) registers its own middleware
// before the session middleware below — the session middleware skips
// /api/v1/* and /api/auth/*.
mountManagementApi(app, { ch });

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/v1/")) return next();
  if (c.req.path.startsWith("/api/auth/")) return next();
  if (c.req.path === "/api/auth-providers") return next();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("userId", session.user.id);
  c.set("orgId", session.session.activeOrganizationId ?? null);
  // Better Auth's admin plugin sets impersonatedBy on the session row when an
  // admin is acting as another user; surface it on `c.var` so /api/me can
  // expose a boolean without the web client having to inspect raw session.
  c.set("impersonating", typeof session.session.impersonatedBy === "string");
  await next();
});

mountMcpAuthed(app);
mountGithubAuthed(app);
mountLinearAuthed(app);
mountSlackAuthed(app);
mountSettingsAuthed(app);
mountOrgKeyManagementAuthed(app);
mountDashboards(app);
mountAlerts(app, { ch });
mountWebhooks(app);
mountFeedbackAuthed(app);
mountAdmin(app, { ch });

const ALLOWED_SIGNUP_SOURCES = new Set(["skill", "web", "mcp", "github", "cli"]);

app.get("/api/me", async (c) => {
  const ctx = await resolveMaybeActiveOrgContext({
    userId: c.var.userId,
    preferredOrgId: c.var.orgId,
  });
  const { user } = ctx;

  // Pre-org users (just signed up, haven't created their first org yet) get a
  // null org/project so the web client can route them to the create-org step
  // in the onboarding wizard.
  if (!ctx.org) {
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isStaff: userIsStaff(user.role),
        impersonating: c.var.impersonating === true,
      },
      org: null,
      project: null,
    });
  }

  const { org, project } = ctx;

  if (!org.signupSource) {
    const headerSource = c.req.header("x-superlog-signup-source")?.trim().toLowerCase();
    if (headerSource && ALLOWED_SIGNUP_SOURCES.has(headerSource)) {
      const updated = await db
        .update(schema.orgs)
        .set({ signupSource: headerSource })
        .where(and(eq(schema.orgs.id, org.id), isNull(schema.orgs.signupSource)))
        .returning({ signupSource: schema.orgs.signupSource });
      if (updated[0]?.signupSource) org.signupSource = updated[0].signupSource;
    }
  }

  void upsertLoopsContact({
    user,
    org,
    project,
    signupSource: org.signupSource,
    appUrl: WEB_ORIGIN,
  }).catch((err) => {
    logger.warn({ err, userId: user.id, orgId: org.id }, "loops contact sync failed");
  });

  const accessibleInstalls = await listAccessibleGithubInstallsForProject(project.id);
  const githubSetupNeeded = accessibleInstalls.length === 0 && !org.githubSetupSkippedAt;

  // `hasIngested` decides whether OnboardingGate shows the install wizard. Reading
  // it from api_keys.last_used_at (set by proxy/src/index.ts on every successful
  // auth) avoids 6 ClickHouse count() queries per page load — the previous gate
  // derived this from /stats and was firing on every navigation forever.
  const ingestedKey = await db.query.apiKeys.findFirst({
    columns: { id: true },
    where: and(eq(schema.apiKeys.projectId, project.id), isNotNull(schema.apiKeys.lastUsedAt)),
  });
  const hasIngested = ingestedKey !== undefined;

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isStaff: userIsStaff(user.role),
      impersonating: c.var.impersonating === true,
    },
    org: { id: org.id, name: org.name, slug: org.slug, githubSetupNeeded },
    project: { id: project.id, name: project.name, slug: project.slug, hasIngested },
  });
});

app.put("/api/me/active-project", async (c) => {
  const { user, org } = await resolveActiveOrgContext({
    userId: c.var.userId,
    preferredOrgId: c.var.orgId,
  });
  const body = (await c.req.json().catch(() => ({}))) as { projectId?: unknown };
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  if (!projectId) throw new HTTPException(400, { message: "projectId required" });

  const project = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, org.id)),
  });
  if (!project) throw new HTTPException(404, { message: "project not found in active org" });

  await db
    .update(schema.users)
    .set({ activeProjectId: project.id })
    .where(eq(schema.users.id, user.id));

  return c.json({ project: { id: project.id, name: project.name, slug: project.slug } });
});

const ORG_NAME_MAX = 80;

function slugifyOrgName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function uniqueOrgSlug(client: Pick<typeof db, "query">, base: string): Promise<string> {
  const seed = base || "org";
  let candidate = seed;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = await client.query.orgs.findFirst({ where: eq(schema.orgs.slug, candidate) });
    if (!existing) return candidate;
    candidate = `${seed.slice(0, 32)}-${nanoid(6).toLowerCase()}`;
  }
  return `${seed.slice(0, 20)}-${nanoid(12).toLowerCase()}`;
}

// First-org creation. Called by the onboarding wizard's create-org step for
// users that signed up but don't have a membership yet. Idempotent on retry:
// if the user already has an org, returns it instead of creating a duplicate.
app.post("/api/me/orgs", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  if (!rawName) throw new HTTPException(400, { message: "name required" });
  if (rawName.length > ORG_NAME_MAX) {
    throw new HTTPException(400, { message: `name must be ${ORG_NAME_MAX} chars or fewer` });
  }

  const userId = c.var.userId;
  type WelcomePayload = {
    user: { id: string; email: string };
    org: typeof schema.orgs.$inferSelect;
    project: typeof schema.projects.$inferSelect;
  };

  const result = await db.transaction(
    async (
      tx,
    ): Promise<{
      payload: {
        org: { id: string; name: string; slug: string };
        project: { id: string; name: string; slug: string };
      };
      welcome: WelcomePayload | null;
    }> => {
      // Serializes first-org creation for a user. Without this lock, two
      // concurrent create-org requests can both see no membership and create two
      // organizations before either membership row exists.
      const [user] = await tx
        .select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for("update");
      if (!user) throw new HTTPException(404, { message: "user not found" });

      const existingMembership = await tx.query.orgMembers.findFirst({
        where: eq(schema.orgMembers.userId, userId),
      });
      if (existingMembership) {
        const org = await tx.query.orgs.findFirst({
          where: eq(schema.orgs.id, existingMembership.orgId),
        });
        if (!org)
          throw new HTTPException(500, { message: "org membership references missing org" });
        let project = await tx.query.projects.findFirst({
          where: eq(schema.projects.orgId, org.id),
        });
        if (!project) {
          const [createdProject] = await tx
            .insert(schema.projects)
            .values({ orgId: org.id, name: "Default", slug: "default" })
            .returning();
          if (!createdProject) {
            throw new HTTPException(500, { message: "failed to create default project" });
          }
          project = createdProject;
          await tx
            .insert(schema.projectAutomationSettings)
            .values({ projectId: project.id })
            .onConflictDoNothing({ target: schema.projectAutomationSettings.projectId });
        }
        return {
          payload: {
            org: { id: org.id, name: org.name, slug: org.slug },
            project: { id: project.id, name: project.name, slug: project.slug },
          },
          welcome: null,
        };
      }

      const slug = await uniqueOrgSlug(tx, slugifyOrgName(rawName));
      const [org] = await tx.insert(schema.orgs).values({ name: rawName, slug }).returning();
      if (!org) throw new HTTPException(500, { message: "failed to create org" });

      await tx
        .insert(schema.orgMembers)
        .values({ orgId: org.id, userId, role: "owner" })
        .onConflictDoNothing({ target: [schema.orgMembers.orgId, schema.orgMembers.userId] });

      const [project] = await tx
        .insert(schema.projects)
        .values({ orgId: org.id, name: "Default", slug: "default" })
        .returning();
      if (!project) throw new HTTPException(500, { message: "failed to create default project" });

      await tx
        .insert(schema.projectAutomationSettings)
        .values({ projectId: project.id })
        .onConflictDoNothing({ target: schema.projectAutomationSettings.projectId });

      // Promote the new org to active on every session this user has open, so the
      // next /api/me call returns it without requiring a sign-out/sign-in round trip.
      await tx
        .update(schema.sessions)
        .set({ activeOrganizationId: org.id })
        .where(
          and(eq(schema.sessions.userId, userId), isNull(schema.sessions.activeOrganizationId)),
        );

      return {
        payload: {
          org: { id: org.id, name: org.name, slug: org.slug },
          project: { id: project.id, name: project.name, slug: project.slug },
        },
        welcome: { user, org, project },
      };
    },
  );

  if (result.welcome) {
    void sendLoopsWelcomeFlow({
      user: result.welcome.user,
      org: result.welcome.org,
      project: result.welcome.project,
      signupSource: result.welcome.org.signupSource,
      appUrl: WEB_ORIGIN,
    }).catch((err) => {
      logger.warn({ err, userId, orgId: result.welcome?.org.id }, "loops welcome flow failed");
    });
  }

  return c.json(result.payload);
});

app.post("/api/signup-intents/:intentId/claim", async (c) => {
  const intentId = c.req.param("intentId");
  const body = (await c.req.json().catch(() => ({}))) as { projectId?: unknown };
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  if (!projectId) throw new HTTPException(400, { message: "projectId required" });

  const { user, org } = await resolveActiveOrgContext({
    userId: c.var.userId,
    preferredOrgId: c.var.orgId,
  });
  const project = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, org.id)),
  });
  if (!project) throw new HTTPException(404, { message: "project not found in active org" });

  const claimed = await db.transaction(async (tx) => {
    const intent = await tx.query.signupIntents.findFirst({
      where: eq(schema.signupIntents.id, intentId),
    });
    if (!intent) throw new HTTPException(404, { message: "signup intent not found" });
    if (intent.expiresAt < new Date()) {
      logger.warn(
        {
          intent_id: intentId,
          project_id: projectId,
          user_id: c.var.userId,
          expires_at: intent.expiresAt.toISOString(),
          age_ms: Date.now() - intent.expiresAt.getTime(),
        },
        "signup intent expired",
      );
      throw new HTTPException(410, { message: "signup intent expired" });
    }
    if (intent.consumedAt) {
      if (intent.claimedProjectId === project.id) {
        return {
          id: null,
          keyPrefix: intent.keyPrefix,
          returnTo: intent.returnTo,
          alreadyClaimed: true,
        };
      }
      throw new HTTPException(409, { message: "signup intent already claimed" });
    }

    const existingKey = await tx.query.apiKeys.findFirst({
      where: eq(schema.apiKeys.keyHash, intent.keyHash),
    });
    if (existingKey && existingKey.projectId !== project.id) {
      throw new HTTPException(409, {
        message: "signup intent key already belongs to another project",
      });
    }

    const [key] = existingKey
      ? [existingKey]
      : await tx
          .insert(schema.apiKeys)
          .values({
            projectId: project.id,
            name: "Skill onboarding",
            keyHash: intent.keyHash,
            keyPrefix: intent.keyPrefix,
          })
          .returning();
    if (!key) throw new Error("failed to claim signup intent key");

    await tx
      .update(schema.signupIntents)
      .set({
        consumedAt: new Date(),
        claimedProjectId: project.id,
        claimedByUserId: user.id,
      })
      .where(eq(schema.signupIntents.id, intent.id));

    return {
      id: key.id,
      keyPrefix: key.keyPrefix,
      returnTo: intent.returnTo,
      alreadyClaimed: false,
    };
  });

  return c.json(claimed);
});

app.post("/api/projects/:projectId/keys", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  return tracer.startActiveSpan("apikey.create", async (span) => {
    span.setAttribute("tenant.project_id", projectId);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { name?: string };
      const name = body.name?.trim() || "new key";
      span.setAttribute("apikey.name", name);
      const minted = await mintApiKey({ projectId, name });
      span.setAttribute("apikey.prefix", minted.keyPrefix);
      span.setAttribute("apikey.id", minted.id);
      return c.json({
        id: minted.id,
        name: minted.name,
        keyPrefix: minted.keyPrefix,
        createdAt: minted.createdAt,
        plaintext: minted.plaintext,
      });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
});

app.get("/api/projects/:projectId/keys", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const rows = await db.query.apiKeys.findMany({
    where: eq(schema.apiKeys.projectId, projectId),
  });
  return c.json(
    rows.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
    })),
  );
});

app.delete("/api/projects/:projectId/keys/:keyId", async (c) => {
  const projectId = c.req.param("projectId");
  const keyId = c.req.param("keyId");
  await requireProjectAccess(c, projectId);
  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.projectId, projectId)));
  return c.json({ ok: true });
});

// Reports whether the user has connected at least one MCP client to this
// project. Used by the dashboard's setup-todos to hide the "Install the MCP
// server" card once a token exists. Counts non-revoked tokens whose refresh
// is still valid (or never expires) — clients with only stale access tokens
// will still re-auth, so we don't gate on `accessExpiresAt`.
app.get("/api/projects/:projectId/mcp-status", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const rows = await db
    .select({ id: schema.mcpOauthTokens.id })
    .from(schema.mcpOauthTokens)
    .where(
      and(eq(schema.mcpOauthTokens.projectId, projectId), isNull(schema.mcpOauthTokens.revokedAt)),
    )
    .limit(1);
  return c.json({ connected: rows.length > 0 });
});

app.get("/api/projects/:projectId/stats", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const [traces, logs, metrics, issueRows] = await Promise.all([
    chCount("otel_traces", "Timestamp", projectId),
    chCount("otel_logs", "Timestamp", projectId),
    chMetricsCount(projectId),
    db.select({ c: count() }).from(schema.issues).where(eq(schema.issues.projectId, projectId)),
  ]);
  return c.json({
    window: "1h",
    traces,
    logs,
    metrics,
    issues: Number(issueRows[0]?.c ?? 0),
  });
});

// Immediate "cancel my paid plan" → Free. Autumn's React SDK / better-auth
// plugin doesn't expose cancel, and downgrades otherwise schedule to cycle end,
// so we do it server-side with the secret key: cancel any active paid plan now
// (cancel_immediately), then attach Free (which isn't the default product, so a
// bare cancel would leave the org with no plan). Per-org (org = Autumn customer).
app.post("/api/me/billing/cancel", async (c) => {
  const ctx = await resolveMaybeActiveOrgContext({
    userId: c.var.userId,
    preferredOrgId: c.var.orgId,
  });
  if (!ctx.org) throw new HTTPException(400, { message: "no active org" });
  const key = process.env.AUTUMN_SECRET_KEY;
  if (!key) throw new HTTPException(400, { message: "billing is not configured" });
  const orgId = ctx.org.id;
  // "Switch to Free" — per Autumn's guidance, attach the Free plan immediately
  // and carry usage over, rather than cancelling the paid plan. When a paid
  // plan is active this is a real downgrade: planSchedule:"immediate" applies it
  // now and carryOverUsages preserves the org's metered usage (spans / logs /
  // metric points / investigation credits) so a maxed cap can't be reset by
  // toggling paid↔Free. (Cancelling instead spins up a fresh Free entitlement
  // with usage 0 — the reset we were fighting; and billing.update has no
  // carry-over option.) If the org is ALREADY on Free (Free is the auto_enable
  // default), the attach 409s "plan_already_attached" — that's a no-op success.
  const autumn = new Autumn({ secretKey: key });
  try {
    await autumn.billing.attach({
      customerId: orgId,
      planId: "free",
      planSchedule: "immediate",
      carryOverUsages: { enabled: true },
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    const body = String((err as { body?: unknown }).body ?? (err as Error).message ?? "");
    if (status === 409 || body.includes("plan_already_attached")) {
      return c.json({ ok: true }); // already on Free
    }
    throw err;
  }
  return c.json({ ok: true });
});

app.get("/api/projects/:projectId/explore/attribute-keys", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const { since, until } = parseRangeQuery(c);
  const rows = await listAttributeKeys(ch, projectId, { since, until });
  return c.json(rows);
});

app.get("/api/projects/:projectId/explore/attribute-values", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const key = c.req.query("key");
  if (!key) throw new HTTPException(400, { message: "key is required" });
  const { since, until } = parseRangeQuery(c);
  const rows = await listAttributeValues(ch, projectId, key, { since, until });
  return c.json(rows);
});

app.get("/api/projects/:projectId/explore/services", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const { since, until } = parseRangeQuery(c);
  const services = await listServices(ch, projectId, { since, until });
  return c.json(services);
});

app.post("/api/projects/:projectId/explore/logs", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  return tracer.startActiveSpan("explore.query_logs", async (span) => {
    span.setAttribute("tenant.project_id", projectId);
    try {
      const body = (await c.req.json().catch(() => ({}))) as ExploreListBody;
      const limit = clampLimit(body.limit, 100, 500);
      span.setAttribute("explore.limit", limit);
      if (body.service) span.setAttribute("explore.service", body.service);
      if (body.severity) span.setAttribute("explore.severity", body.severity);
      if (body.search) span.setAttribute("explore.has_search", true);
      const rows = await queryLogs(ch, projectId, {
        range: body.range,
        service: body.service,
        severity: body.severity,
        search: body.search,
        resourceAttrs: normalizeAttrs(body.resourceAttrs),
        limit,
      });
      span.setAttribute("explore.row_count", rows.length);
      return c.json(rows);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
});

app.post("/api/projects/:projectId/explore/traces", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const body = (await c.req.json().catch(() => ({}))) as ExploreListBody;
  const limit = clampLimit(body.limit, 100, 500);
  const rows = await queryTraces(ch, projectId, {
    range: body.range,
    service: body.service,
    spanName: body.spanName,
    statusCode: body.statusCode,
    minDurationMs: body.minDurationMs,
    resourceAttrs: normalizeAttrs(body.resourceAttrs),
    limit,
  });
  return c.json(rows);
});

app.post("/api/projects/:projectId/explore/traces-aggregated", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const body = (await c.req.json().catch(() => ({}))) as ExploreListBody;
  const limit = clampLimit(body.limit, 100, 500);
  const rows = await queryTracesAggregated(ch, projectId, {
    range: body.range,
    service: body.service,
    spanName: body.spanName,
    statusCode: body.statusCode,
    minDurationMs: body.minDurationMs,
    resourceAttrs: normalizeAttrs(body.resourceAttrs),
    limit,
  });
  return c.json(rows);
});

app.get("/api/projects/:projectId/explore/traces/:traceId", async (c) => {
  const projectId = c.req.param("projectId");
  const traceId = c.req.param("traceId");
  await requireProjectAccess(c, projectId);
  if (!/^[a-fA-F0-9]{1,64}$/.test(traceId)) {
    throw new HTTPException(400, { message: "invalid trace id" });
  }
  const detail = await getTraceDetail(ch, projectId, traceId);
  return c.json(detail);
});

app.post("/api/projects/:projectId/explore/series", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const body = (await c.req.json().catch(() => ({}))) as ExploreSeriesBody;
  const source: SeriesSource = body.source === "traces" ? "traces" : "logs";
  const filter = body.filter ?? {};
  const rangeSeconds = estimateRangeSeconds(filter.range);
  const step = pickStep(rangeSeconds);
  const rows = await countSeries(
    ch,
    projectId,
    source,
    {
      range: filter.range,
      service: filter.service,
      resourceAttrs: normalizeAttrs(filter.resourceAttrs),
      search: filter.search,
      severity: filter.severity,
      spanName: filter.spanName,
      statusCode: filter.statusCode,
      minDurationMs: filter.minDurationMs,
    },
    body.groupBy || undefined,
    step,
  );
  return c.json({ step: `${step.n} ${step.unit}`, rows });
});

app.get("/api/projects/:projectId/explore/metric-names", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const { since, until } = parseRangeQuery(c);
  const names = await listMetricNames(ch, projectId, { since, until });
  return c.json(names);
});

app.post("/api/projects/:projectId/explore/metric-series", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const body = (await c.req.json().catch(() => ({}))) as MetricSeriesBody;
  const metricName = typeof body.metricName === "string" ? body.metricName : "";
  const filter = body.filter ?? {};
  const rangeSeconds = estimateRangeSeconds(filter.range);
  const step = pickStep(rangeSeconds);
  const aggregation =
    typeof body.aggregation === "string" &&
    (METRIC_AGGREGATIONS as readonly string[]).includes(body.aggregation)
      ? (body.aggregation as MetricAggregation)
      : undefined;
  const rows = await metricSeries(
    ch,
    projectId,
    metricName,
    {
      range: filter.range,
      service: filter.service,
      resourceAttrs: normalizeAttrs(filter.resourceAttrs),
    },
    body.groupBy || undefined,
    step,
    aggregation,
  );
  return c.json({ step: `${step.n} ${step.unit}`, rows });
});

app.post("/api/projects/:projectId/explore/metrics", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const body = (await c.req.json().catch(() => ({}))) as ExploreListBody & { metricName?: string };
  const limit = clampLimit(body.limit, 100, 500);
  const rows = await queryMetrics(ch, projectId, {
    metricName: typeof body.metricName === "string" ? body.metricName : undefined,
    range: body.range,
    service: body.service,
    resourceAttrs: normalizeAttrs(body.resourceAttrs),
    limit,
  });
  return c.json(rows);
});

type MetricSeriesBody = {
  metricName?: string;
  groupBy?: string;
  aggregation?: string;
  filter?: Omit<ExploreListBody, "limit">;
};

type ExploreListBody = {
  range?: { since?: string; until?: string };
  service?: string;
  resourceAttrs?: ResourceAttrFilter[];
  search?: string;
  severity?: string;
  spanName?: string;
  statusCode?: string;
  minDurationMs?: number;
  limit?: number;
};

type ExploreSeriesBody = {
  source?: SeriesSource;
  groupBy?: string;
  filter?: Omit<ExploreListBody, "limit">;
};

function parseRangeQuery(c: Context<{ Variables: Vars }>): { since?: string; until?: string } {
  const since = c.req.query("since");
  const until = c.req.query("until");
  return { since, until };
}

function clampLimit(n: number | undefined, fallback: number, max: number): number {
  const v = Math.floor(Number(n ?? fallback));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(v, max);
}

function isIncidentStatus(value: string): value is schema.IncidentStatus {
  return (
    value === "open" || value === "resolved" || value === "autoresolved_noise" || value === "merged"
  );
}

function normalizeAttrs(attrs: ResourceAttrFilter[] | undefined): ResourceAttrFilter[] | undefined {
  if (!Array.isArray(attrs)) return undefined;
  const out = attrs.filter(
    (a): a is ResourceAttrFilter =>
      !!a &&
      typeof a.key === "string" &&
      a.key.length > 0 &&
      typeof a.value === "string" &&
      (a.op === undefined || a.op === "eq" || a.op === "neq" || a.op === "not_contains"),
  );
  return out.length > 0 ? out : undefined;
}

function estimateRangeSeconds(range: { since?: string; until?: string } | undefined): number {
  if (!range?.since || !range?.until) return 3600;
  const s = Date.parse(range.since);
  const u = Date.parse(range.until);
  if (!Number.isFinite(s) || !Number.isFinite(u) || u <= s) return 3600;
  return (u - s) / 1000;
}

async function chCount(table: string, tsColumn: string, projectId: string): Promise<number> {
  const r = await ch.query({
    query: `
      SELECT count() AS c
      FROM ${table}
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND ${tsColumn} > now() - INTERVAL 1 HOUR
    `,
    query_params: { projectId },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { c: string | number }[];
  return Number(rows[0]?.c ?? 0);
}

async function chMetricsCount(projectId: string): Promise<number> {
  return tracer.startActiveSpan("metrics.aggregate_counts", async (span) => {
    span.setAttribute("tenant.project_id", projectId);
    try {
      const tables = [
        "otel_metrics_gauge",
        "otel_metrics_sum",
        "otel_metrics_histogram",
        "otel_metrics_summary",
        "otel_metrics_exp_histogram",
      ];
      span.setAttribute("metrics.table_count", tables.length);
      const counts = await Promise.all(tables.map((t) => chCount(t, "TimeUnix", projectId)));
      const total = counts.reduce((a, b) => a + b, 0);
      span.setAttribute("metrics.total", total);
      return total;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

async function requireProjectAccess(
  c: Context<{ Variables: Vars }>,
  projectId: string,
): Promise<void> {
  return tracer.startActiveSpan("project.authorize", async (span) => {
    span.setAttribute("tenant.project_id", projectId);
    span.setAttribute("superlog.user_id", c.var.userId);
    if (c.var.orgId) span.setAttribute("superlog.org_id_hint", c.var.orgId);
    try {
      const project = await db.query.projects.findFirst({
        where: eq(schema.projects.id, projectId),
      });
      if (!project) throw new HTTPException(404, { message: "project not found" });
      const ctx = await resolveActiveOrgContext({
        userId: c.var.userId,
        preferredOrgId: c.var.orgId,
      });
      if (project.orgId !== ctx.org.id) throw new HTTPException(403, { message: "forbidden" });
      span.setAttribute("superlog.org_id", ctx.org.id);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

async function getProjectAutomation(projectId: string): Promise<{
  autoInvestigateIssuesEnabled: boolean;
  agentRunProvider: string;
  maxRuntimeMinutes: number;
  maxHumanResumeCount: number;
  customInstructions: string;
  agentRunEnabled: boolean;
  linearTicketPolicy: schema.LinearTicketPolicy;
  linearTicketInstructions: schema.LinearTicketInstruction[];
  prPolicy: schema.PrPolicy;
  autoMergeFixPrs: schema.AutoMergePolicy;
  autoMergeMethod: schema.AutoMergeMethod;
  issueFilterConfig: schema.IssueFilterConfig;
}> {
  const row = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
  });
  return {
    autoInvestigateIssuesEnabled: row?.autoInvestigateIssuesEnabled ?? true,
    agentRunProvider: row?.agentRunProvider ?? DEFAULT_AGENT_RUN_PROVIDER,
    maxRuntimeMinutes: row?.maxRuntimeMinutes ?? 90,
    maxHumanResumeCount: row?.maxHumanResumeCount ?? 3,
    customInstructions: row?.customInstructions ?? "",
    agentRunEnabled: row?.agentRunEnabled ?? true,
    linearTicketPolicy: row?.linearTicketPolicy ?? "on_ready_to_pr",
    linearTicketInstructions: row?.linearTicketInstructions ?? [],
    prPolicy: row?.prPolicy ?? "on_ready_to_pr",
    autoMergeFixPrs: row?.autoMergeFixPrs ?? "never",
    autoMergeMethod: row?.autoMergeMethod ?? "squash",
    issueFilterConfig: row?.issueFilterConfig ?? schema.EMPTY_ISSUE_FILTER_CONFIG,
  };
}

function sanitizeClauseList(input: unknown): schema.IssueFilterClause[] {
  if (!Array.isArray(input)) return [];
  const out: schema.IssueFilterClause[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const key =
      typeof (item as { key?: unknown }).key === "string"
        ? (item as { key: string }).key.trim()
        : "";
    const value =
      typeof (item as { value?: unknown }).value === "string"
        ? (item as { value: string }).value.trim()
        : "";
    if (!key || !value) continue;
    const dedupe = `${key.toLowerCase()}=${value}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ key: key.slice(0, 200), value: value.slice(0, 400) });
    if (out.length >= 20) break;
  }
  return out;
}

function sanitizeIssueFilterConfig(
  input: unknown,
  fallback: schema.IssueFilterConfig,
): schema.IssueFilterConfig {
  if (!input || typeof input !== "object") return fallback;
  const o = input as Partial<Record<keyof schema.IssueFilterConfig, unknown>>;
  return {
    includeLogs: sanitizeClauseList(o.includeLogs),
    includeSpans: sanitizeClauseList(o.includeSpans),
    excludeLogs: sanitizeClauseList(o.excludeLogs),
    excludeSpans: sanitizeClauseList(o.excludeSpans),
  };
}

async function getProjectIncident(projectId: string, incidentId: string) {
  return db.query.incidents.findFirst({
    where: and(eq(schema.incidents.id, incidentId), eq(schema.incidents.projectId, projectId)),
  });
}

async function getLatestAgentRun(incidentId: string) {
  return db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.incidentId, incidentId),
    orderBy: [desc(schema.agentRuns.createdAt)],
  });
}

app.get("/api/projects/:projectId/issues", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const silencedParam = c.req.query("silenced") ?? "active";
  const limit = clampLimit(Number(c.req.query("limit") ?? 50), 50, 200);
  const projectFilter = eq(schema.issues.projectId, projectId);
  const where =
    silencedParam === "all"
      ? projectFilter
      : silencedParam === "silenced"
        ? and(projectFilter, isNotNull(schema.issues.silencedAt))
        : and(projectFilter, isNull(schema.issues.silencedAt));
  const rows = await db.query.issues.findMany({
    where,
    orderBy: [desc(schema.issues.lastSeen)],
    limit,
  });
  return c.json(rows);
});

app.get("/api/projects/:projectId/issues/:issueId", async (c) => {
  const projectId = c.req.param("projectId");
  const issueId = c.req.param("issueId");
  await requireProjectAccess(c, projectId);
  const issue = await db.query.issues.findFirst({
    where: and(eq(schema.issues.id, issueId), eq(schema.issues.projectId, projectId)),
  });
  if (!issue) throw new HTTPException(404, { message: "issue not found" });
  return c.json(issue);
});

app.post("/api/projects/:projectId/issues/lookup", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: "log" | "span";
    service?: string | null;
    severity?: string | null;
    body?: string | null;
    exceptionType?: string | null;
    exceptionMessage?: string | null;
    stacktrace?: string | null;
  };
  const kind = body.kind === "span" ? "span" : "log";
  const fp =
    kind === "span"
      ? fingerprint({
          type: body.exceptionType || body.severity || "Error",
          stacktrace: body.stacktrace ?? null,
          message: body.exceptionMessage ?? body.body ?? null,
        })
      : fingerprintLog({
          service: body.service ?? "",
          severity: body.severity ?? "",
          body: body.body ?? "",
          exceptionType: body.exceptionType ?? null,
          stacktrace: body.stacktrace ?? null,
        });
  const issue = await db.query.issues.findFirst({
    where: and(eq(schema.issues.projectId, projectId), eq(schema.issues.fingerprint, fp.hash)),
  });
  return c.json({ issue: issue ?? null });
});

app.get("/api/projects/:projectId/issues/:issueId/agent-run", async (c) => {
  const projectId = c.req.param("projectId");
  const issueId = c.req.param("issueId");
  await requireProjectAccess(c, projectId);

  const issue = await db.query.issues.findFirst({
    where: and(eq(schema.issues.id, issueId), eq(schema.issues.projectId, projectId)),
  });
  if (!issue) throw new HTTPException(404, { message: "issue not found" });

  const link = await db.query.incidentIssues.findFirst({
    where: eq(schema.incidentIssues.issueId, issueId),
  });
  if (!link) return c.json({ incident: null, agentRun: null, events: [] });

  const incident = await getProjectIncident(projectId, link.incidentId);
  if (!incident) return c.json({ incident: null, agentRun: null, events: [] });

  const agentRun = await getLatestAgentRun(incident.id);
  if (!agentRun) return c.json({ incident, agentRun: null, events: [] });

  const events = await loadIncidentTimeline(incident.id, agentRun.id);

  return c.json({ incident, agentRun, events });
});

app.patch("/api/projects/:projectId/incidents/:incidentId", async (c) => {
  const projectId = c.req.param("projectId");
  const incidentId = c.req.param("incidentId");
  await requireProjectAccess(c, projectId);
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status = body.status;
  if (status !== "open" && status !== "resolved") {
    throw new HTTPException(400, { message: "status must be 'open' or 'resolved'" });
  }
  const existing = await db.query.incidents.findFirst({
    where: and(eq(schema.incidents.id, incidentId), eq(schema.incidents.projectId, projectId)),
  });
  if (!existing) throw new HTTPException(404, { message: "incident not found" });

  if (status === "resolved") {
    // Route the dashboard's mark-resolved through the shared helper so the
    // resolved_* columns are populated exactly like every other resolve path.
    await resolveIncident({
      incidentId,
      kind: "dashboard_manual",
      reasonCode: "dashboard_manual",
      reasonText: `Resolved from the dashboard by user ${c.var.userId}.`,
      resolvedByUserId: c.var.userId,
    });
  } else {
    await incidentLifecycle.reopenManually({
      incident: existing,
      actor: { userId: c.var.userId },
      summary: "Incident reopened from the dashboard.",
      detail: { reason: "dashboard_manual" },
    });
  }

  const updated = await db.query.incidents.findFirst({
    where: and(eq(schema.incidents.id, incidentId), eq(schema.incidents.projectId, projectId)),
  });
  return c.json(updated);
});

// Confirm/dismiss a pending resolution proposal from the dashboard. The
// proposalId in the path is the source of truth — projectId/incidentId
// are validated for access control and to make the URL self-documenting.
// Both routes route through the same shared helper the Slack handler
// uses, so confirmed/dismissed proposals from either surface look
// identical in the audit log.
async function decideResolutionProposal(
  c: Context<{ Variables: Vars }>,
  decision: "confirm" | "dismiss",
): Promise<Response> {
  const projectId = c.req.param("projectId");
  const incidentId = c.req.param("incidentId");
  const proposalId = c.req.param("proposalId");
  if (!projectId || !incidentId || !proposalId) {
    throw new HTTPException(400, { message: "missing path parameter" });
  }
  await requireProjectAccess(c, projectId);

  const proposal = await db.query.incidentResolutionProposals.findFirst({
    where: eq(schema.incidentResolutionProposals.id, proposalId),
  });
  if (!proposal || proposal.incidentId !== incidentId) {
    throw new HTTPException(404, { message: "proposal not found" });
  }
  // Make sure the proposal belongs to this project — defence in depth on
  // the project-access check above (the incident's projectId is the
  // authoritative one).
  const incident = await db.query.incidents.findFirst({
    where: and(eq(schema.incidents.id, incidentId), eq(schema.incidents.projectId, projectId)),
  });
  if (!incident) throw new HTTPException(404, { message: "incident not found" });

  // Look up the user's name for the attribution phrase. Skip if the user
  // row is gone (e.g. just-deleted account); the helper falls back to the
  // user id.
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, c.var.userId),
    columns: { id: true, name: true, email: true },
  });
  const displayName = user?.name?.trim() || user?.email || null;

  const actor = { userId: c.var.userId, displayName };
  const result =
    decision === "confirm"
      ? await confirmResolutionProposal({ proposalId, actor })
      : await dismissResolutionProposal({ proposalId, actor });
  if (!result.ok) {
    // already_confirmed / already_dismissed land as 409 so the dashboard
    // can refresh and show the up-to-date state without treating it as a
    // hard error.
    if (result.reason?.startsWith("already_")) {
      throw new HTTPException(409, { message: result.reason });
    }
    throw new HTTPException(400, { message: result.reason ?? "decision failed" });
  }
  return c.json({ ok: true, incidentId, proposalId, decision });
}

app.post(
  "/api/projects/:projectId/incidents/:incidentId/resolution-proposals/:proposalId/confirm",
  (c) => decideResolutionProposal(c, "confirm"),
);
app.post(
  "/api/projects/:projectId/incidents/:incidentId/resolution-proposals/:proposalId/dismiss",
  (c) => decideResolutionProposal(c, "dismiss"),
);

app.post("/api/projects/:projectId/issues/:issueId/silence", async (c) => {
  const projectId = c.req.param("projectId");
  const issueId = c.req.param("issueId");
  await requireProjectAccess(c, projectId);
  return tracer.startActiveSpan("issue.silence", async (span) => {
    span.setAttribute("tenant.project_id", projectId);
    span.setAttribute("issue.id", issueId);
    try {
      const updated = await db
        .update(schema.issues)
        .set({ silencedAt: new Date() })
        .where(
          and(
            eq(schema.issues.id, issueId),
            eq(schema.issues.projectId, projectId),
            isNull(schema.issues.silencedAt),
          ),
        )
        .returning();
      if (!updated[0]) {
        span.setAttribute("issue.silence.applied", false);
        const existing = await db.query.issues.findFirst({
          where: and(eq(schema.issues.id, issueId), eq(schema.issues.projectId, projectId)),
        });
        if (!existing) throw new HTTPException(404, { message: "issue not found" });
        return c.json(existing);
      }
      span.setAttribute("issue.silence.applied", true);
      return c.json(updated[0]);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
});

app.post("/api/projects/:projectId/issues/:issueId/unsilence", async (c) => {
  const projectId = c.req.param("projectId");
  const issueId = c.req.param("issueId");
  await requireProjectAccess(c, projectId);
  const existing = await db.query.issues.findFirst({
    where: and(eq(schema.issues.id, issueId), eq(schema.issues.projectId, projectId)),
  });
  if (!existing) throw new HTTPException(404, { message: "issue not found" });
  if (!existing.silencedAt) return c.json(existing);
  const conflict = await db.query.issues.findFirst({
    where: and(
      eq(schema.issues.projectId, projectId),
      eq(schema.issues.fingerprint, existing.fingerprint),
      isNull(schema.issues.silencedAt),
    ),
  });
  if (conflict) {
    throw new HTTPException(409, {
      message: "another active issue already exists for this fingerprint",
    });
  }
  const updated = await db
    .update(schema.issues)
    .set({ silencedAt: null })
    .where(and(eq(schema.issues.id, issueId), eq(schema.issues.projectId, projectId)))
    .returning();
  return c.json(updated[0] ?? existing);
});

app.get("/api/projects/:projectId/automation", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const current = await getProjectAutomation(projectId);
  return c.json({ projectId, ...current });
});

// Picker support for the Issue filter editor — keys/values/preview are drawn
// from ERROR events only (logs SeverityNumber>=17, traces with exception
// event) so the UI matches the population the worker filter applies to.
const ISSUE_FILTER_RANGE = "now() - INTERVAL 24 HOUR";

app.get("/api/projects/:projectId/issue-filter/attribute-keys", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const rows = await listIssueFilterAttributeKeys(ch, projectId, {
    since: ISSUE_FILTER_RANGE,
  });
  return c.json(rows);
});

app.get("/api/projects/:projectId/issue-filter/attribute-values", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const key = c.req.query("key");
  if (!key) throw new HTTPException(400, { message: "key is required" });
  const rows = await listIssueFilterAttributeValues(ch, projectId, key, {
    since: ISSUE_FILTER_RANGE,
  });
  return c.json(rows);
});

// POST because the filter is now a structured object with 4 lists, which
// doesn't fit cleanly in a query string.
app.post("/api/projects/:projectId/issue-filter/preview", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const body = (await c.req.json().catch(() => ({}))) as {
    config?: unknown;
  };
  const config = sanitizeIssueFilterConfig(body.config, schema.EMPTY_ISSUE_FILTER_CONFIG);
  const events = await previewIssueFilterMatches(
    ch,
    projectId,
    config,
    { since: ISSUE_FILTER_RANGE },
    10,
  );
  return c.json({ events });
});

const VALID_AGENT_POLICIES: ReadonlySet<string> = new Set(["never", "on_ready_to_pr", "always"]);
const VALID_AUTO_MERGE_POLICIES: ReadonlySet<string> = new Set([
  "never",
  "when_checks_pass",
  "immediately",
]);
const VALID_AUTO_MERGE_METHODS: ReadonlySet<string> = new Set(["squash", "merge", "rebase"]);
const MAX_INSTRUCTIONS_LEN = 8000;

app.patch("/api/projects/:projectId/automation", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);

  const current = await getProjectAutomation(projectId);
  const body = (await c.req.json().catch(() => ({}))) as {
    autoInvestigateIssuesEnabled?: unknown;
    agentRunProvider?: unknown;
    maxRuntimeMinutes?: unknown;
    maxHumanResumeCount?: unknown;
    customInstructions?: unknown;
    agentRunEnabled?: unknown;
    linearTicketPolicy?: unknown;
    linearTicketInstructions?: unknown;
    prPolicy?: unknown;
    autoMergeFixPrs?: unknown;
    autoMergeMethod?: unknown;
    issueFilterConfig?: unknown;
  };

  const autoInvestigateIssuesEnabled =
    typeof body.autoInvestigateIssuesEnabled === "boolean"
      ? body.autoInvestigateIssuesEnabled
      : current.autoInvestigateIssuesEnabled;
  const agentRunProvider =
    typeof body.agentRunProvider === "string" ? body.agentRunProvider : current.agentRunProvider;
  const maxRuntimeMinutes =
    typeof body.maxRuntimeMinutes === "number"
      ? Math.floor(body.maxRuntimeMinutes)
      : current.maxRuntimeMinutes;
  const maxHumanResumeCount =
    typeof body.maxHumanResumeCount === "number"
      ? Math.floor(body.maxHumanResumeCount)
      : current.maxHumanResumeCount;
  const customInstructions =
    typeof body.customInstructions === "string"
      ? body.customInstructions.slice(0, MAX_INSTRUCTIONS_LEN)
      : current.customInstructions;
  const agentRunEnabled =
    typeof body.agentRunEnabled === "boolean" ? body.agentRunEnabled : current.agentRunEnabled;
  const linearTicketPolicy: schema.LinearTicketPolicy =
    typeof body.linearTicketPolicy === "string" && VALID_AGENT_POLICIES.has(body.linearTicketPolicy)
      ? (body.linearTicketPolicy as schema.LinearTicketPolicy)
      : current.linearTicketPolicy;
  const linearTicketInstructions: schema.LinearTicketInstruction[] = (() => {
    if (!Array.isArray(body.linearTicketInstructions)) return current.linearTicketInstructions;
    const validated = body.linearTicketInstructions
      .filter(
        (item): item is { id: string; title: string; text: string } =>
          item !== null &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          typeof item.text === "string",
      )
      .slice(0, 20)
      .map((item) => ({
        id: item.id,
        title: item.title.slice(0, 200),
        text: item.text.slice(0, 2000),
      }));
    return validated;
  })();
  const prPolicy: schema.PrPolicy =
    typeof body.prPolicy === "string" && VALID_AGENT_POLICIES.has(body.prPolicy)
      ? (body.prPolicy as schema.PrPolicy)
      : current.prPolicy;
  const autoMergeFixPrs: schema.AutoMergePolicy =
    typeof body.autoMergeFixPrs === "string" && VALID_AUTO_MERGE_POLICIES.has(body.autoMergeFixPrs)
      ? (body.autoMergeFixPrs as schema.AutoMergePolicy)
      : current.autoMergeFixPrs;
  const autoMergeMethod: schema.AutoMergeMethod =
    typeof body.autoMergeMethod === "string" && VALID_AUTO_MERGE_METHODS.has(body.autoMergeMethod)
      ? (body.autoMergeMethod as schema.AutoMergeMethod)
      : current.autoMergeMethod;
  const issueFilterConfig =
    body.issueFilterConfig !== undefined
      ? sanitizeIssueFilterConfig(body.issueFilterConfig, current.issueFilterConfig)
      : current.issueFilterConfig;

  if (!isAgentRunProvider(agentRunProvider)) {
    throw new HTTPException(400, {
      message: "agentRunProvider must be one of: community, anthropic, disabled",
    });
  }
  if (!Number.isFinite(maxRuntimeMinutes) || maxRuntimeMinutes < 1 || maxRuntimeMinutes > 720) {
    throw new HTTPException(400, { message: "maxRuntimeMinutes must be between 1 and 720" });
  }
  if (
    !Number.isFinite(maxHumanResumeCount) ||
    maxHumanResumeCount < 0 ||
    maxHumanResumeCount > 10
  ) {
    throw new HTTPException(400, { message: "maxHumanResumeCount must be between 0 and 10" });
  }

  const values = {
    projectId,
    autoInvestigateIssuesEnabled,
    agentRunProvider,
    maxRuntimeMinutes,
    maxHumanResumeCount,
    customInstructions,
    agentRunEnabled,
    linearTicketPolicy,
    linearTicketInstructions,
    prPolicy,
    autoMergeFixPrs,
    autoMergeMethod,
    issueFilterConfig,
    updatedAt: new Date(),
  };

  const updated = await db
    .insert(schema.projectAutomationSettings)
    .values(values)
    .onConflictDoUpdate({
      target: schema.projectAutomationSettings.projectId,
      set: {
        autoInvestigateIssuesEnabled,
        agentRunProvider,
        maxRuntimeMinutes,
        maxHumanResumeCount,
        customInstructions,
        agentRunEnabled,
        linearTicketPolicy,
        linearTicketInstructions,
        prPolicy,
        autoMergeFixPrs,
        autoMergeMethod,
        issueFilterConfig,
        updatedAt: new Date(),
      },
    })
    .returning();

  return c.json(updated[0] ?? values);
});

app.get("/api/projects/:projectId/incidents", async (c) => {
  const projectId = c.req.param("projectId");
  await requireProjectAccess(c, projectId);
  const limit = clampLimit(Number(c.req.query("limit") ?? 50), 50, 200);
  const status = c.req.query("status");
  const incidentStatus = status && status !== "all" && isIncidentStatus(status) ? status : null;
  if (status && status !== "all" && !incidentStatus) {
    throw new HTTPException(400, { message: "invalid incident status" });
  }

  // Default view hides agent-classified noise. Pass ?status=all to include it,
  // or ?status=autoresolved_noise to inspect just the noise pile.
  const baseFilter = eq(schema.incidents.projectId, projectId);
  let where = !status
    ? and(baseFilter, ne(schema.incidents.status, "autoresolved_noise"))
    : baseFilter;
  if (incidentStatus) {
    where = and(baseFilter, eq(schema.incidents.status, incidentStatus));
  }
  const incidents = await db.query.incidents.findMany({
    where,
    orderBy: [desc(schema.incidents.lastSeen)],
    limit,
  });
  const [agentRuns, pendingProposals] = await Promise.all([
    Promise.all(incidents.map((incident) => getLatestAgentRun(incident.id))),
    loadPendingResolutionProposals(incidents.map((i) => i.id)),
  ]);

  // Graph stats hit ClickHouse and can be slow on large projects. Keep the list
  // itself Postgres-only by default; callers that still need the legacy inline
  // shape can opt in with ?includeStats=1 while the web UI lazy-loads rows.
  const inlineStats = shouldInlineIncidentListStats(c.req.query("includeStats"));
  const statsByIncidentId = inlineStats
    ? await loadIncidentsBucketStats(
        projectId,
        incidents.map((i) => i.id),
      )
    : new Map<string, IncidentBucketStats>();
  const emptyStats: IncidentBucketStats = {
    buckets: buildBucketsFromMap(new Map(), INCIDENT_STATS_WINDOW_DAYS),
    impactedUsers: 0,
    impactedUsersAvailable: false,
    impactedUsersCapped: false,
  };

  return c.json(
    incidents.map((incident, index) =>
      buildIncidentListItem({
        incident,
        agentRun: agentRuns[index] ?? null,
        pendingResolutionProposal: pendingProposals.get(incident.id) ?? null,
        stats: inlineStats
          ? {
              windowDays: INCIDENT_STATS_WINDOW_DAYS,
              ...(statsByIncidentId.get(incident.id) ?? emptyStats),
            }
          : undefined,
      }),
    ),
  );
});

type IncidentBucketStats = {
  buckets: { day: string; count: number }[];
  impactedUsers: number;
  impactedUsersAvailable: boolean;
  impactedUsersCapped: boolean;
};

// Bulk version of the per-incident stats query, used by the incidents list.
// Two ClickHouse round-trips: one returns (svc, et, day, count) tuples for
// the sparkline, the other returns (svc, et) → distinct user.id arrays.
// We then map each tuple back to whichever incident's issues had that
// (svc, et) pair, summing counts and Set-unioning users per-incident.
// Same approximation as the single-incident endpoint — see
// `fetchIncidentTimeseriesPairs`.
async function loadIncidentsBucketStats(
  projectId: string,
  incidentIds: string[],
): Promise<Map<string, IncidentBucketStats>> {
  if (incidentIds.length === 0) return new Map();

  const links = await db.query.incidentIssues.findMany({
    where: inArray(schema.incidentIssues.incidentId, incidentIds),
  });
  if (links.length === 0) return new Map();

  const issues = await db.query.issues.findMany({
    where: inArray(
      schema.issues.id,
      links.map((l) => l.issueId),
    ),
  });
  if (issues.length === 0) return new Map();

  const issueById = new Map(issues.map((i) => [i.id, i] as const));
  // incidentId -> list of (kind, svc, et) it cares about
  const incidentPairs = new Map<string, { kind: "span" | "log"; svc: string; et: string }[]>();
  for (const link of links) {
    const issue = issueById.get(link.issueId);
    if (!issue) continue;
    const arr = incidentPairs.get(link.incidentId) ?? [];
    arr.push({
      kind: issue.kind === "log" ? "log" : "span",
      svc: issue.service ?? "",
      et: issue.exceptionType ?? "",
    });
    incidentPairs.set(link.incidentId, arr);
  }

  // Union all pairs into the CH query (one round-trip).
  const spanServices: string[] = [];
  const spanExcTypes: string[] = [];
  const logServices: string[] = [];
  const logExcTypes: string[] = [];
  const seenSpan = new Set<string>();
  const seenLog = new Set<string>();
  for (const pairs of incidentPairs.values()) {
    for (const p of pairs) {
      const key = pairKey2(p.svc, p.et);
      if (p.kind === "log") {
        if (!seenLog.has(key)) {
          seenLog.add(key);
          logServices.push(p.svc);
          logExcTypes.push(p.et);
        }
      } else {
        if (!seenSpan.has(key)) {
          seenSpan.add(key);
          spanServices.push(p.svc);
          spanExcTypes.push(p.et);
        }
      }
    }
  }

  // Delimiter unlikely to appear in service / exception_type — keeps the
  // composite map key unambiguous so ("ab","c") and ("a","bc") don't collide.
  const tupleKey = (kind: string, svc: string, et: string) => `${kind}${svc}${et}`;

  const [rows, userRows] = await Promise.all([
    fetchIncidentTimeseriesPairs({
      projectId,
      spanServices,
      spanExcTypes,
      logServices,
      logExcTypes,
      windowDays: INCIDENT_STATS_WINDOW_DAYS,
    }),
    fetchIncidentUserIdsByPair({
      projectId,
      spanServices,
      spanExcTypes,
      logServices,
      logExcTypes,
      windowDays: INCIDENT_STATS_WINDOW_DAYS,
    }),
  ]);

  const tupleCounts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = tupleKey(r.kind, r.svc, r.et);
    let byDay = tupleCounts.get(key);
    if (!byDay) {
      byDay = new Map();
      tupleCounts.set(key, byDay);
    }
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count);
  }
  const tupleUsers = new Map<string, { users: string[]; capped: boolean }>();
  for (const r of userRows) {
    tupleUsers.set(tupleKey(r.kind, r.svc, r.et), {
      users: r.users,
      // groupUniqArray returns up to N rows; if we got exactly N we likely
      // truncated. A false positive here just shows "200+" once — better
      // than under-reporting a genuinely viral incident.
      capped: r.users.length >= INCIDENT_USERS_CAP,
    });
  }

  const out = new Map<string, IncidentBucketStats>();
  for (const [incidentId, pairs] of incidentPairs) {
    const merged = new Map<string, number>();
    const userUnion = new Set<string>();
    let capped = false;
    // A single incident may have two issues whose (kind, svc, et) tuples are
    // equal; dedupe so we don't double-count counts or users.
    const tupleKeys = new Set(pairs.map((p) => tupleKey(p.kind, p.svc, p.et)));
    for (const key of tupleKeys) {
      const byDay = tupleCounts.get(key);
      if (byDay) for (const [day, c] of byDay) merged.set(day, (merged.get(day) ?? 0) + c);
      const tu = tupleUsers.get(key);
      if (tu) {
        for (const uid of tu.users) userUnion.add(uid);
        if (tu.capped) capped = true;
      }
    }
    out.set(incidentId, {
      buckets: buildBucketsFromMap(merged, INCIDENT_STATS_WINDOW_DAYS),
      impactedUsers: userUnion.size,
      impactedUsersAvailable: userUnion.size > 0,
      impactedUsersCapped: capped,
    });
  }
  return out;
}

app.get("/api/projects/:projectId/incidents/:incidentId", async (c) => {
  const projectId = c.req.param("projectId");
  const incidentId = c.req.param("incidentId");
  await requireProjectAccess(c, projectId);

  const incident = await getProjectIncident(projectId, incidentId);
  if (!incident) throw new HTTPException(404, { message: "incident not found" });

  const [links, agentRuns] = await Promise.all([
    db.query.incidentIssues.findMany({
      where: eq(schema.incidentIssues.incidentId, incidentId),
      orderBy: [desc(schema.incidentIssues.createdAt)],
    }),
    db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
      orderBy: [desc(schema.agentRuns.createdAt)],
    }),
  ]);
  const issues =
    links.length > 0
      ? await db.query.issues.findMany({
          where: inArray(
            schema.issues.id,
            links.map((link) => link.issueId),
          ),
          orderBy: [desc(schema.issues.lastSeen)],
        })
      : [];

  // Timeline is the incident's own — events from incident_events scoped to
  // this incident (and any of its agent runs), plus PR/Linear ticket events.
  // Findings (root cause, severity, etc.) on `incident` are the primary
  // source of truth; the timeline + agent-run history ride along on the
  // same GET so the detail panel renders in one round trip.
  const latestAgentRun = agentRuns[0] ?? null;
  const [timeline, pendingProposalMap] = await Promise.all([
    latestAgentRun ? loadIncidentTimeline(incident.id, latestAgentRun.id) : Promise.resolve([]),
    loadPendingResolutionProposals([incident.id]),
  ]);

  return c.json({
    incident,
    issues,
    agentRun: latestAgentRun,
    agentRuns,
    timeline,
    pendingResolutionProposal: pendingProposalMap.get(incident.id) ?? null,
  });
});

const INCIDENT_STATS_WINDOW_DAYS = 14;

// Composite-key delimiter for (kind, service, exception_type) tuples. ASCII SOH
// is never a legal char in any of those fields, so it guarantees ("ab","c") and
// ("a","bc") get distinct keys.
const PAIR_KEY_SEP = "";
const pairKey2 = (svc: string, et: string) => `${svc}${PAIR_KEY_SEP}${et}`;

// Backfills the last N days as zero so the bar chart always shows a continuous timeline.
function buildBucketsFromMap(
  countsByDay: Map<string, number>,
  windowDays: number,
): { day: string; count: number }[] {
  const buckets: { day: string; count: number }[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    buckets.push({ day: key, count: countsByDay.get(key) ?? 0 });
  }
  return buckets;
}

// Per-incident user-id sample cap. groupUniqArray(N) limits the response payload
// so a viral incident doesn't blow up the list endpoint; the per-incident count
// displayed in the UI is exact up to this cap, and "200+" thereafter.
const INCIDENT_USERS_CAP = 200;

// Bulk fetch distinct user IDs per (kind, service, exception_type) across a project.
// Caller maps the returned tuples back to incidents and Set-unions per-incident.
async function fetchIncidentUserIdsByPair(args: {
  projectId: string;
  spanServices: string[];
  spanExcTypes: string[];
  logServices: string[];
  logExcTypes: string[];
  windowDays: number;
}): Promise<{ kind: "span" | "log"; svc: string; et: string; users: string[] }[]> {
  const { projectId, spanServices, spanExcTypes, logServices, logExcTypes, windowDays } = args;
  if (spanServices.length === 0 && logServices.length === 0) return [];

  const spanWhere =
    spanServices.length === 0
      ? "0"
      : `(coalesce(ServiceName, ''), coalesce(event_attrs['exception.type'], '')) IN arrayZip({spanServices:Array(String)}, {spanExcTypes:Array(String)})`;
  const logWhere =
    logServices.length === 0
      ? "0"
      : `(coalesce(ServiceName, ''), coalesce(LogAttributes['exception.type'], '')) IN arrayZip({logServices:Array(String)}, {logExcTypes:Array(String)})`;

  const query = `
    SELECT 'span' AS kind,
      coalesce(ServiceName, '') AS svc,
      coalesce(event_attrs['exception.type'], '') AS et,
      groupUniqArray(${INCIDENT_USERS_CAP})(nullIf(coalesce(SpanAttributes['user.id'], ResourceAttributes['user.id']), '')) AS users
    FROM (
      SELECT Timestamp, ServiceName, SpanAttributes, ResourceAttributes, Events.Name, Events.Attributes
      FROM otel_traces
      WHERE Timestamp > now() - INTERVAL {days:UInt32} DAY
        AND ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND has({spanServices:Array(String)}, coalesce(ServiceName, ''))
        AND has(Events.Name, 'exception')
    )
    ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
    WHERE event_name = 'exception'
      AND ${spanWhere}
    GROUP BY svc, et
    UNION ALL
    SELECT 'log' AS kind,
      coalesce(ServiceName, '') AS svc,
      coalesce(LogAttributes['exception.type'], '') AS et,
      groupUniqArray(${INCIDENT_USERS_CAP})(nullIf(coalesce(LogAttributes['user.id'], ResourceAttributes['user.id']), '')) AS users
    FROM otel_logs
    WHERE Timestamp > now() - INTERVAL {days:UInt32} DAY
      AND ResourceAttributes['superlog.project_id'] = {projectId:String}
      AND SeverityNumber >= 17
      AND has({logServices:Array(String)}, coalesce(ServiceName, ''))
      AND ${logWhere}
    GROUP BY svc, et
  `;

  const res = await ch.query({
    query,
    query_params: {
      projectId,
      days: windowDays,
      spanServices,
      spanExcTypes,
      logServices,
      logExcTypes,
    },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as {
    kind: "span" | "log";
    svc: string;
    et: string;
    users: string[];
  }[];
  return rows;
}

// Bulk fetch per-(service, exception_type, day) counts for spans + logs across a project.
// Caller maps the returned tuples back to incidents. The incident → telemetry link is
// approximate: fingerprints live in pg only, so we filter by the fingerprint *inputs*
// (exception.type, optionally service). This over-counts slightly when two distinct
// stacktraces share an exception type in the same service — fine for a sparkline.
async function fetchIncidentTimeseriesPairs(args: {
  projectId: string;
  spanServices: string[];
  spanExcTypes: string[];
  logServices: string[];
  logExcTypes: string[];
  windowDays: number;
}): Promise<{ svc: string; et: string; day: string; count: number; kind: "span" | "log" }[]> {
  const { projectId, spanServices, spanExcTypes, logServices, logExcTypes, windowDays } = args;
  if (spanServices.length === 0 && logServices.length === 0) return [];

  const spanWhere =
    spanServices.length === 0
      ? "0"
      : `(coalesce(ServiceName, ''), coalesce(event_attrs['exception.type'], '')) IN arrayZip({spanServices:Array(String)}, {spanExcTypes:Array(String)})`;
  const logWhere =
    logServices.length === 0
      ? "0"
      : `(coalesce(ServiceName, ''), coalesce(LogAttributes['exception.type'], '')) IN arrayZip({logServices:Array(String)}, {logExcTypes:Array(String)})`;

  const query = `
    SELECT 'span' AS kind,
      coalesce(ServiceName, '') AS svc,
      coalesce(event_attrs['exception.type'], '') AS et,
      toString(toDate(Timestamp)) AS day,
      count() AS c
    FROM (
      SELECT Timestamp, ServiceName, Events.Name, Events.Attributes
      FROM otel_traces
      WHERE Timestamp > now() - INTERVAL {days:UInt32} DAY
        AND ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND has({spanServices:Array(String)}, coalesce(ServiceName, ''))
        AND has(Events.Name, 'exception')
    )
    ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
    WHERE event_name = 'exception'
      AND ${spanWhere}
    GROUP BY svc, et, day
    UNION ALL
    SELECT 'log' AS kind,
      coalesce(ServiceName, '') AS svc,
      coalesce(LogAttributes['exception.type'], '') AS et,
      toString(toDate(Timestamp)) AS day,
      count() AS c
    FROM otel_logs
    WHERE Timestamp > now() - INTERVAL {days:UInt32} DAY
      AND ResourceAttributes['superlog.project_id'] = {projectId:String}
      AND SeverityNumber >= 17
      AND has({logServices:Array(String)}, coalesce(ServiceName, ''))
      AND ${logWhere}
    GROUP BY svc, et, day
  `;

  const res = await ch.query({
    query,
    query_params: {
      projectId,
      days: windowDays,
      spanServices,
      spanExcTypes,
      logServices,
      logExcTypes,
    },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as {
    kind: "span" | "log";
    svc: string;
    et: string;
    day: string;
    c: string | number;
  }[];
  return rows.map((r) => ({ ...r, count: Number(r.c) }));
}

// Daily event counts + impacted-user count for an incident's underlying telemetry.
app.get("/api/projects/:projectId/incidents/:incidentId/stats", async (c) => {
  const projectId = c.req.param("projectId");
  const incidentId = c.req.param("incidentId");
  await requireProjectAccess(c, projectId);

  const incident = await getProjectIncident(projectId, incidentId);
  if (!incident) throw new HTTPException(404, { message: "incident not found" });

  const windowDays = INCIDENT_STATS_WINDOW_DAYS;
  const empty = {
    windowDays,
    buckets: [] as { day: string; count: number }[],
    totalEvents: 0,
    impactedUsers: 0,
    impactedUsersAvailable: false,
  };

  const links = await db.query.incidentIssues.findMany({
    where: eq(schema.incidentIssues.incidentId, incidentId),
  });
  if (links.length === 0) return c.json(empty);

  const issues = await db.query.issues.findMany({
    where: inArray(
      schema.issues.id,
      links.map((l) => l.issueId),
    ),
  });
  if (issues.length === 0) return c.json(empty);

  const fingerprints = [...new Set(issues.map((issue) => issue.fingerprint).filter(Boolean))];
  const aggregateParams: Record<string, unknown> = {
    projectId,
    days: windowDays,
    fingerprints,
  };
  const aggregateQuery = `
    SELECT toString(day) AS bucket_day, sum(event_count) AS count
    FROM issue_activity_daily
    WHERE project_id = {projectId:String}
      AND fingerprint IN {fingerprints:Array(String)}
      AND day >= today() - ({days:UInt32} - 1)
    GROUP BY day
    ORDER BY day ASC
  `;

  const spanNamesBySample = await loadSpanNamesForIssueSamples(projectId, issues).catch((err) => {
    logger.warn(
      { err, projectId, incidentId },
      "incident span-name lookup unavailable; using unscoped span stats",
    );
    return new Map<string, string>();
  });
  const {
    namedSpanServices,
    namedSpanNames,
    namedSpanExcTypes,
    unnamedSpanServices,
    unnamedSpanExcTypes,
    logServices,
    logExcTypes,
  } = buildIncidentStatsPairs(issues, spanNamesBySample);

  // Match spans against the incident's fingerprint inputs. When we can resolve
  // SpanName from the issue sample, include it so ClickHouse can use the
  // (ServiceName, SpanName, Timestamp) primary key instead of scanning every
  // exception span for a busy service.
  const namedSpanWhere =
    namedSpanServices.length === 0
      ? "0"
      : `(coalesce(ServiceName, ''), coalesce(SpanName, ''), coalesce(event_attrs['exception.type'], '')) IN arrayZip({namedSpanServices:Array(String)}, {namedSpanNames:Array(String)}, {namedSpanExcTypes:Array(String)})`;
  const unnamedSpanWhere =
    unnamedSpanServices.length === 0
      ? "0"
      : `(coalesce(ServiceName, ''), coalesce(event_attrs['exception.type'], '')) IN arrayZip({unnamedSpanServices:Array(String)}, {unnamedSpanExcTypes:Array(String)})`;
  const spanWhere = `(${namedSpanWhere} OR ${unnamedSpanWhere})`;
  const logWhere =
    logServices.length === 0
      ? "0"
      : `(coalesce(ServiceName, ''), coalesce(LogAttributes['exception.type'], '')) IN arrayZip({logServices:Array(String)}, {logExcTypes:Array(String)})`;

  const params: Record<string, unknown> = {
    projectId,
    days: windowDays,
    namedSpanServices,
    namedSpanNames,
    namedSpanExcTypes,
    unnamedSpanServices,
    unnamedSpanExcTypes,
    logServices,
    logExcTypes,
  };
  const fallbackStats = buildIncidentStatsFromIssues(issues, { windowDays });

  const bucketsQuery = `
    SELECT day, sum(c) AS c
    FROM (
      SELECT toString(toDate(Timestamp)) AS day, count() AS c
      FROM (
        SELECT Timestamp, ServiceName, SpanName, Events.Name, Events.Attributes
        FROM otel_traces
        WHERE Timestamp > now() - INTERVAL {days:UInt32} DAY
          AND ResourceAttributes['superlog.project_id'] = {projectId:String}
          AND (
            has({namedSpanServices:Array(String)}, coalesce(ServiceName, ''))
            OR has({unnamedSpanServices:Array(String)}, coalesce(ServiceName, ''))
          )
          AND (
            has({unnamedSpanServices:Array(String)}, coalesce(ServiceName, ''))
            OR has({namedSpanNames:Array(String)}, coalesce(SpanName, ''))
          )
          AND has(Events.Name, 'exception')
      )
      ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
      WHERE event_name = 'exception'
        AND ${spanWhere}
      GROUP BY day
      UNION ALL
      SELECT toString(toDate(Timestamp)) AS day, count() AS c
      FROM otel_logs
      WHERE Timestamp > now() - INTERVAL {days:UInt32} DAY
        AND ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND SeverityNumber >= 17
        AND has({logServices:Array(String)}, coalesce(ServiceName, ''))
        AND ${logWhere}
      GROUP BY day
    )
    GROUP BY day
    ORDER BY day ASC
  `;

  const usersQuery = `
    SELECT
      uniqExact(uid) AS users,
      countIf(uid IS NOT NULL) AS tagged_events
    FROM (
      SELECT nullIf(coalesce(SpanAttributes['user.id'], ResourceAttributes['user.id']), '') AS uid
      FROM (
        SELECT Timestamp, ServiceName, SpanName, SpanAttributes, ResourceAttributes, Events.Name, Events.Attributes
        FROM otel_traces
        WHERE Timestamp > now() - INTERVAL {days:UInt32} DAY
          AND ResourceAttributes['superlog.project_id'] = {projectId:String}
          AND (
            has({namedSpanServices:Array(String)}, coalesce(ServiceName, ''))
            OR has({unnamedSpanServices:Array(String)}, coalesce(ServiceName, ''))
          )
          AND (
            has({unnamedSpanServices:Array(String)}, coalesce(ServiceName, ''))
            OR has({namedSpanNames:Array(String)}, coalesce(SpanName, ''))
          )
          AND has(Events.Name, 'exception')
      )
      ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
      WHERE event_name = 'exception'
        AND ${spanWhere}
      UNION ALL
      SELECT nullIf(coalesce(LogAttributes['user.id'], ResourceAttributes['user.id']), '') AS uid
      FROM otel_logs
      WHERE Timestamp > now() - INTERVAL {days:UInt32} DAY
        AND ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND SeverityNumber >= 17
        AND has({logServices:Array(String)}, coalesce(ServiceName, ''))
        AND ${logWhere}
    )
  `;

  const stats = await buildIncidentStatsWithFallback({
    fallback: fallbackStats,
    // Stay below the ClickHouse client's 10s request timeout so this endpoint
    // returns issue-derived activity instead of surfacing a 500 to the drawer.
    timeoutMs: 8_500,
    onTelemetryUnavailable: (reason, err) => {
      logger.warn(
        { err, reason, projectId, incidentId },
        "incident telemetry stats unavailable; returning issue fallback",
      );
    },
    loadTelemetry: async (signal) => {
      try {
        const activityRes = await ch.query({
          query: aggregateQuery,
          query_params: aggregateParams,
          format: "JSONEachRow",
          abort_signal: signal,
        });
        const activityRows = (await activityRes.json()) as {
          bucket_day: string;
          count: string | number;
        }[];
        return buildIncidentStatsFromActivityRows(
          activityRows.map((row) => ({ day: row.bucket_day, count: row.count })),
          { windowDays },
        );
      } catch (err) {
        logger.warn(
          { err, projectId, incidentId },
          "incident fingerprint activity aggregate unavailable; falling back to raw telemetry stats",
        );
      }

      const [bucketsRes, usersRes] = await Promise.all([
        ch.query({
          query: bucketsQuery,
          query_params: params,
          format: "JSONEachRow",
          abort_signal: signal,
        }),
        ch.query({
          query: usersQuery,
          query_params: params,
          format: "JSONEachRow",
          abort_signal: signal,
        }),
      ]);

      const bucketRows = (await bucketsRes.json()) as { day: string; c: string | number }[];
      const userRows = (await usersRes.json()) as {
        users: string | number;
        tagged_events: string | number;
      }[];

      const countsByDay = new Map(bucketRows.map((r) => [r.day, Number(r.c)]));
      const buckets = buildBucketsFromMap(countsByDay, windowDays);
      const totalEvents = buckets.reduce((a, b) => a + b.count, 0);
      const taggedEvents = Number(userRows[0]?.tagged_events ?? 0);

      return {
        windowDays,
        buckets,
        totalEvents,
        impactedUsers: Number(userRows[0]?.users ?? 0),
        // false ⇒ no event in the window had a user.id attribute, so the UI can show a
        // "not instrumented" hint and link to the OTel onboarding skill.
        impactedUsersAvailable: taggedEvents > 0,
      };
    },
  });

  return c.json(stats);
});

async function loadSpanNamesForIssueSamples(
  projectId: string,
  issues: Pick<Issue, "kind" | "lastSample">[],
): Promise<Map<string, string>> {
  const samples: { traceId: string; spanId: string }[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.kind === "log" || issue.lastSample?.spanName) continue;
    const traceId = issue.lastSample?.traceId;
    const spanId = issue.lastSample?.spanId;
    if (!traceId || !spanId) continue;
    const key = spanSampleKey(traceId, spanId);
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({ traceId, spanId });
  }
  if (samples.length === 0) return new Map();

  const res = await ch.query({
    query: `
      SELECT
        TraceId AS trace_id,
        SpanId AS span_id,
        any(SpanName) AS span_name
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND TraceId IN {traceIds:Array(String)}
        AND SpanId IN {spanIds:Array(String)}
      GROUP BY trace_id, span_id
    `,
    query_params: {
      projectId,
      traceIds: samples.map((s) => s.traceId),
      spanIds: samples.map((s) => s.spanId),
    },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { trace_id: string; span_id: string; span_name: string }[];
  return new Map(
    rows
      .filter((row) => row.span_name)
      .map((row) => [spanSampleKey(row.trace_id, row.span_id), row.span_name]),
  );
}

// Pull the latest open (decision IS NULL) resolution proposal for each
// incident id. Returns a Map keyed by incident id so the caller can
// stitch it into the response without an N+1 query. Empty input → empty
// map (no DB roundtrip).
async function loadPendingResolutionProposals(
  incidentIds: string[],
): Promise<Map<string, PendingResolutionProposal>> {
  if (incidentIds.length === 0) return new Map();
  const rows = await db.query.incidentResolutionProposals.findMany({
    where: and(
      inArray(schema.incidentResolutionProposals.incidentId, incidentIds),
      isNull(schema.incidentResolutionProposals.decision),
    ),
    orderBy: [desc(schema.incidentResolutionProposals.proposedAt)],
  });
  // One open proposal per incident is the invariant — the gating in the
  // sweep selector enforces it — but defensively pick the newest if for
  // some reason multiple exist (e.g. mid-migration data).
  const map = new Map<string, PendingResolutionProposal>();
  for (const row of rows) {
    if (map.has(row.incidentId)) continue;
    map.set(row.incidentId, {
      id: row.id,
      sourceKind: row.sourceKind,
      confidence: row.confidence,
      proposedReasonCode: row.proposedReasonCode,
      proposedReasonText: row.proposedReasonText,
      proposedAt: row.proposedAt.toISOString(),
    });
  }
  return map;
}

type PendingResolutionProposal = {
  id: string;
  sourceKind: string;
  confidence: schema.IncidentResolutionProposalConfidence;
  proposedReasonCode: string;
  proposedReasonText: string;
  proposedAt: string;
};

// Back-compat: returns the same {agentRun, events} shape the web client
// used pre-merge. The main `/incidents/:id` GET now folds this in.
app.get("/api/projects/:projectId/incidents/:incidentId/agent-run", async (c) => {
  const projectId = c.req.param("projectId");
  const incidentId = c.req.param("incidentId");
  await requireProjectAccess(c, projectId);

  const incident = await getProjectIncident(projectId, incidentId);
  if (!incident) throw new HTTPException(404, { message: "incident not found" });

  const agentRun = await getLatestAgentRun(incident.id);
  // An incident may have lifecycle events (manual resolve from the
  // dashboard or Slack, sweep proposal confirmed) without ever having
  // had an agent run — pass a never-matches uuid so loadIncidentTimeline
  // returns only the incident-scoped lifecycle events.
  const events = await loadIncidentTimeline(
    incident.id,
    agentRun?.id ?? "00000000-0000-0000-0000-000000000000",
  );

  return c.json({ agentRun: agentRun ?? null, events });
});

app.post("/api/projects/:projectId/incidents/:incidentId/agent-run/restart", async (c) => {
  const projectId = c.req.param("projectId");
  const incidentId = c.req.param("incidentId");
  await requireProjectAccess(c, projectId);

  const incident = await getProjectIncident(projectId, incidentId);
  if (!incident) throw new HTTPException(404, { message: "incident not found" });

  const latest = await getLatestAgentRun(incident.id);
  if (!latest) throw new HTTPException(404, { message: "agent run not found" });

  const automation = await getProjectAutomation(projectId);
  if (!automation.agentRunEnabled) {
    throw new HTTPException(400, { message: "incident agent_runs are disabled" });
  }

  const activeStates = [
    "queued",
    "repo_discovery",
    "running",
    "awaiting_human",
    "pr_retry_queued",
    "blocked_no_github",
  ];
  const now = new Date();
  const agentRun = await db.transaction(async (tx) => {
    const superseded = await tx
      .update(schema.agentRuns)
      .set({ state: "superseded", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentRuns.incidentId, incident.id),
          inArray(schema.agentRuns.state, activeStates),
        ),
      )
      .returning({ id: schema.agentRuns.id });

    if (superseded.length > 0) {
      await tx.insert(schema.incidentEvents).values(
        superseded.map((row) => ({
          agentRunId: row.id,
          kind: "agent_run_superseded",
          summary: "Investigation superseded by a restart.",
          dedupeKey: `superseded:${row.id}:${now.getTime()}`,
          processedAt: now,
        })),
      );
    }

    const [created] = await tx
      .insert(schema.agentRuns)
      .values({
        incidentId: incident.id,
        runtime: automation.agentRunProvider,
        state: "queued",
      })
      .returning();
    if (!created) throw new Error("failed to restart agent run");

    await tx.insert(schema.incidentEvents).values({
      agentRunId: created.id,
      kind: "agent_run_restarted",
      summary: "Investigation restarted.",
      detail: {
        restartedFromAgentRunId: latest.id,
        restartedFromState: latest.state,
      },
      dedupeKey: `restart:${created.id}`,
      processedAt: now,
    });

    return created;
  });

  return c.json(agentRun);
});

app.post("/api/projects/:projectId/incidents/:incidentId/agent-run/retry-pr", async (c) => {
  const projectId = c.req.param("projectId");
  const incidentId = c.req.param("incidentId");
  await requireProjectAccess(c, projectId);

  const incident = await getProjectIncident(projectId, incidentId);
  if (!incident) throw new HTTPException(404, { message: "incident not found" });

  const latest = await getLatestAgentRun(incident.id);
  if (!latest) throw new HTTPException(404, { message: "agent run not found" });
  const eligibility = getPrDeliveryRetryEligibility(latest ?? null);
  if (!eligibility.canRetry) {
    throw new HTTPException(400, { message: eligibility.reason });
  }

  const now = new Date();
  const agentRun = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.agentRuns)
      .set({
        state: "pr_retry_queued",
        failureReason: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentRuns.id, latest.id),
          eq(schema.agentRuns.state, "failed"),
          eq(schema.agentRuns.failureReason, "pr_open_failed"),
        ),
      )
      .returning();
    if (!updated) throw new HTTPException(409, { message: "agent run is no longer retryable" });

    await tx.insert(schema.incidentEvents).values({
      agentRunId: updated.id,
      kind: "agent_run_pr_retry_queued",
      summary: "PR delivery retry queued.",
      detail: {
        retriedFromState: latest.state,
        selectedRepoFullName: latest.result?.pr?.selectedRepoFullName ?? null,
        branchName: latest.result?.pr?.branchName ?? null,
      },
      dedupeKey: `pr-retry:${updated.id}:${now.getTime()}`,
      processedAt: now,
    });

    return updated;
  });

  return c.json(agentRun);
});

type TimelineEvent = {
  id: string;
  agentRunId: string;
  kind: string;
  summary: string | null;
  detail: Record<string, unknown> | null;
  // The provider's own event id (Anthropic `sevt_…`). Tool_result events carry
  // the matching `toolUseId` in their detail; pairing logic in the UI keys on
  // this, not on `id` (which is a freshly-allocated row UUID).
  providerEventId: string | null;
  createdAt: string;
  source: "agent_run" | "agent_pr" | "agent_linear";
  actor?: {
    name: string | null;
    avatarUrl: string | null;
    profileUrl: string | null;
  } | null;
};

async function loadIncidentTimeline(
  incidentId: string,
  agentRunId: string,
): Promise<TimelineEvent[]> {
  const [agentRunEvents, prRows, linearTickets] = await Promise.all([
    // Match events on either join key: events tied to this incident's
    // current agent run OR events keyed directly on the incident (manual
    // resolves, sweep proposal confirmations, etc., don't have an
    // agent_run_id to anchor to).
    db.query.incidentEvents.findMany({
      where: or(
        eq(schema.incidentEvents.agentRunId, agentRunId),
        eq(schema.incidentEvents.incidentId, incidentId),
      ),
      orderBy: [asc(schema.incidentEvents.createdAt)],
    }),
    db.query.agentPullRequests.findMany({
      where: eq(schema.agentPullRequests.incidentId, incidentId),
    }),
    db.query.agentLinearTickets.findMany({
      where: eq(schema.agentLinearTickets.incidentId, incidentId),
    }),
  ]);

  const [prEventRows, linearEventRows] = await Promise.all([
    prRows.length === 0
      ? ([] as schema.AgentPrEvent[])
      : db.query.agentPrEvents.findMany({
          where: inArray(
            schema.agentPrEvents.agentPrId,
            prRows.map((r) => r.id),
          ),
          orderBy: [asc(schema.agentPrEvents.occurredAt)],
        }),
    linearTickets.length === 0
      ? ([] as schema.AgentLinearTicketEvent[])
      : db.query.agentLinearTicketEvents.findMany({
          where: inArray(
            schema.agentLinearTicketEvents.agentLinearTicketId,
            linearTickets.map((r) => r.id),
          ),
          orderBy: [asc(schema.agentLinearTicketEvents.occurredAt)],
        }),
  ]);

  const prById = new Map(prRows.map((r) => [r.id, r] as const));
  const linearById = new Map(linearTickets.map((r) => [r.id, r] as const));

  const items: TimelineEvent[] = [];

  for (const ev of agentRunEvents) {
    items.push({
      id: ev.id,
      // The row's own agent_run_id if it has one; fall back to the
      // active agent run id we were called with so consumers that key
      // off `agentRunId` still group events correctly. Lifecycle events
      // without any run context land with the caller-supplied value.
      agentRunId: ev.agentRunId ?? agentRunId,
      kind: ev.kind,
      summary: ev.summary,
      detail: ev.detail,
      providerEventId: ev.providerEventId,
      createdAt: ev.createdAt.toISOString(),
      source: "agent_run",
      actor: null,
    });
  }
  for (const ev of prEventRows) {
    const pr = prById.get(ev.agentPrId);
    items.push({
      id: ev.id,
      agentRunId,
      kind: ev.kind,
      summary: ev.summary,
      detail: {
        ...(ev.payload ?? {}),
        prUrl: pr?.url ?? null,
        prNumber: pr?.prNumber ?? null,
        repoFullName: pr?.repoFullName ?? null,
      },
      providerEventId: ev.providerEventId,
      createdAt: ev.occurredAt.toISOString(),
      source: "agent_pr",
      actor: ev.actorLogin
        ? {
            name: ev.actorLogin,
            avatarUrl: ev.actorAvatarUrl,
            profileUrl: `https://github.com/${ev.actorLogin}`,
          }
        : null,
    });
  }
  for (const ev of linearEventRows) {
    const ticket = linearById.get(ev.agentLinearTicketId);
    items.push({
      id: ev.id,
      agentRunId,
      kind: ev.kind,
      summary: ev.summary,
      detail: {
        ...(ev.payload ?? {}),
        ticketUrl: ticket?.url ?? null,
        ticketIdentifier: ticket?.ticketIdentifier ?? null,
      },
      providerEventId: ev.providerEventId,
      createdAt: ev.occurredAt.toISOString(),
      source: "agent_linear",
      actor: ev.actorName
        ? { name: ev.actorName, avatarUrl: ev.actorAvatarUrl, profileUrl: null }
        : null,
    });
  }

  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return items;
}

if (shouldRunMigrationsOnBoot(process.env)) {
  await runMigrations();
  logger.info({ scope: "db" }, "migrations applied");
} else {
  // Prod: migrations are applied by the dedicated, gated migrate task as the
  // schema-owner role before this service rolls out. The app role can't (and
  // shouldn't) run DDL on boot.
  logger.info({ scope: "db" }, "skipping boot migrations (RUN_MIGRATIONS_ON_BOOT=false)");
}

const server = serve({ fetch: app.fetch, port: PORT });
// Behind the same ALB as the proxy (60s idle timeout). Node's default 5s
// keepAliveTimeout lets Node close idle sockets the ALB still pools, so reused
// connections RST and surface as HTTPCode_ELB_502 / TargetConnectionError even
// though the app is healthy. Keep the target keep-alive above the ALB idle
// timeout, with headersTimeout above keepAliveTimeout per Node's required order.
if ("keepAliveTimeout" in server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
logger.info({ port: PORT }, "superlog api listening");
