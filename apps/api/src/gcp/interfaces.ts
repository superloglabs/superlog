import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireProjectManagerContext } from "../org-authorization-http.js";
import { hasProjectManagerAccess } from "../org-authorization.js";
import { resolveActiveOrgContext } from "../org-context.js";
import type { GcpApplicationConfig } from "./application.js";
import {
  completeGcpAuthorization,
  connectGcpAuthorization,
  getGcpAuthorizationSelection,
  startGcpAuthorization,
} from "./authorization-application.js";
import { DrizzleGcpAuthorizationRepository } from "./authorization-repository.js";
import type {
  GcpAuthorizationRepository,
  GcpConnectionRecord,
  GcpConnectionRepository,
  GcpGateway,
} from "./domain.js";
import { GcpAuthorizationError } from "./domain.js";
import { GoogleGcpGateway } from "./google-gateway.js";
import { DrizzleGcpConnectionRepository } from "./repository.js";
import { signGcpState, verifyGcpState } from "./state.js";

type Vars = { userId: string; orgId: string | null };

export type GcpConnectConfig = GcpApplicationConfig & {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webOrigin: string;
};

type Dependencies = {
  config?: GcpConnectConfig | null;
  gateway?: GcpGateway;
  repository?: GcpConnectionRepository;
  authorizationRepository?: GcpAuthorizationRepository;
};

export function gcpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GcpConnectConfig | null {
  const clientId = env.GCP_OAUTH_CLIENT_ID;
  const clientSecret = env.GCP_OAUTH_CLIENT_SECRET;
  const redirectUri = env.GCP_OAUTH_REDIRECT_URI;
  const integrationProjectId = env.GCP_INTEGRATION_PROJECT_ID;
  const readerServiceAccountEmail = env.GCP_READER_SERVICE_ACCOUNT_EMAIL;
  const pushServiceAccountEmail = env.GCP_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
  const pushEndpoint = env.GCP_PUBSUB_PUSH_ENDPOINT;
  const pushAudience = env.GCP_PUBSUB_PUSH_AUDIENCE ?? pushEndpoint;
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !integrationProjectId ||
    !readerServiceAccountEmail ||
    !pushServiceAccountEmail ||
    !pushEndpoint ||
    !pushAudience ||
    !env.AGENT_SECRETS_KEY
  ) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    webOrigin: env.WEB_ORIGIN ?? "http://localhost:5173",
    integrationProjectId,
    readerServiceAccountEmail,
    pushServiceAccountEmail,
    pushEndpoint,
    pushAudience,
  };
}

function dependencies(input: Dependencies): {
  config: GcpConnectConfig | null;
  gateway: GcpGateway | null;
  repository: GcpConnectionRepository;
  authorizationRepository: GcpAuthorizationRepository;
} {
  const config = input.config !== undefined ? input.config : gcpConfigFromEnv();
  return {
    config,
    gateway: input.gateway ?? (config ? new GoogleGcpGateway(config) : null),
    repository: input.repository ?? new DrizzleGcpConnectionRepository(),
    authorizationRepository:
      input.authorizationRepository ?? new DrizzleGcpAuthorizationRepository(),
  };
}

function authorizationErrorStatus(error: GcpAuthorizationError): 400 | 404 | 409 | 410 {
  if (error.code === "not_found") return 404;
  if (error.code === "expired") return 410;
  if (error.code === "invalid_selection") return 400;
  return 409;
}

async function requireProjectAccess(c: Context<{ Variables: Vars }>, projectId: string) {
  const userId = c.var.userId;
  if (!userId) throw new HTTPException(401, { message: "unauthenticated" });
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!project) throw new HTTPException(404, { message: "project not found" });
  const context = await resolveActiveOrgContext({ userId, preferredOrgId: c.var.orgId });
  if (project.orgId !== context.org.id) throw new HTTPException(403, { message: "forbidden" });
  return { projectId, userId: context.user.id };
}

async function requireProjectManager(c: Context<{ Variables: Vars }>, projectId: string) {
  const { access } = await requireProjectManagerContext(c, projectId);
  return { projectId, userId: access.userId };
}

function monthlySeriesLimit(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.GCP_METRICS_MONTHLY_SERIES_LIMIT ?? "100000000");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 100_000_000;
}

function toPublic(connection: GcpConnectionRecord | null) {
  if (!connection) return { connected: false as const };
  return {
    connected: connection.status === "connected",
    id: connection.id,
    projectId: connection.projectId,
    gcpProjectId: connection.gcpProjectId,
    gcpProjectNumber: connection.gcpProjectNumber,
    status: connection.status,
    lastVerifiedAt: connection.lastVerifiedAt,
    lastLogReceivedAt: connection.lastLogReceivedAt,
    lastMetricsReceivedAt: connection.lastMetricsReceivedAt,
    metricsBudgetMonth: connection.metricsBudgetMonth,
    metricsSeriesRead: connection.metricsSeriesRead,
    metricsMonthlySeriesLimit: monthlySeriesLimit(),
    lastError: connection.lastError,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export function mountGcpAuthed(app: Hono<{ Variables: Vars }>, input: Dependencies = {}): void {
  const { config, gateway, repository, authorizationRepository } = dependencies(input);
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/projects/:projectId/gcp/connection", async (c) => {
    const context = await requireProjectAccess(c, c.req.param("projectId"));
    return c.json(toPublic(await repository.findCurrent(context.projectId)));
  });

  app.post("/api/projects/:projectId/gcp/install-url", async (c) => {
    if (!config || !gateway || !stateSecret)
      return c.json({ error: "GCP connect not configured" }, 503);
    const context = await requireProjectManager(c, c.req.param("projectId"));
    const result = await startGcpAuthorization({
      ...context,
      repository: authorizationRepository,
      gateway,
      signState: (authorizationId) => signGcpState(authorizationId, stateSecret),
    });
    return c.json({ url: result.url });
  });

  app.get("/api/gcp/authorizations/:authorizationId", async (c) => {
    if (!c.var.userId) return c.json({ error: "unauthenticated" }, 401);
    try {
      const session = await getGcpAuthorizationSelection({
        authorizationId: c.req.param("authorizationId"),
        userId: c.var.userId,
        repository: authorizationRepository,
      });
      await requireProjectManager(c, session.projectId);
      return c.json({
        id: session.id,
        expiresAt: session.expiresAt.toISOString(),
        projects: session.projects,
      });
    } catch (error) {
      if (error instanceof GcpAuthorizationError) {
        return c.json({ error: error.message }, authorizationErrorStatus(error));
      }
      throw error;
    }
  });

  app.post("/api/gcp/authorizations/:authorizationId/connect", async (c) => {
    if (!config || !gateway) return c.json({ error: "GCP connect not configured" }, 503);
    if (!c.var.userId) return c.json({ error: "unauthenticated" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { gcpProjectId?: unknown };
    try {
      const session = await getGcpAuthorizationSelection({
        authorizationId: c.req.param("authorizationId"),
        userId: c.var.userId,
        repository: authorizationRepository,
      });
      await requireProjectManager(c, session.projectId);
      await connectGcpAuthorization({
        authorizationId: session.id,
        userId: c.var.userId,
        gcpProjectId: body?.gcpProjectId,
        authorizationRepository,
        connectionRepository: repository,
        gateway,
        config,
      });
      return c.json({ connected: true as const });
    } catch (error) {
      if (error instanceof GcpAuthorizationError) {
        return c.json({ error: error.message }, authorizationErrorStatus(error));
      }
      return c.json(
        { error: error instanceof Error ? error.message : "GCP provisioning failed" },
        502,
      );
    }
  });
}

export function mountGcpPublic(app: Hono<{ Variables: Vars }>, input: Dependencies = {}): void {
  const { config, gateway, authorizationRepository } = dependencies(input);
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/gcp/oauth/callback", async (c) => {
    if (!config || !gateway || !stateSecret)
      return c.json({ error: "GCP connect not configured" }, 503);
    const outcomeUrl = (outcome: "select" | "denied" | "error", authorizationId?: string) => {
      const url = new URL("/connect/gcp", config.webOrigin);
      url.searchParams.set("gcp", outcome);
      if (authorizationId) url.searchParams.set("authorization", authorizationId);
      return url.toString();
    };
    if (c.req.query("error")) {
      const deniedState = verifyGcpState(c.req.query("state") ?? "", stateSecret);
      if (deniedState) {
        await authorizationRepository.markFailed(
          deniedState.authorizationId,
          "Google OAuth access denied",
        );
      }
      return c.redirect(outcomeUrl("denied"), 302);
    }
    const code = c.req.query("code");
    const state = verifyGcpState(c.req.query("state") ?? "", stateSecret);
    if (!code || !state) return c.redirect(outcomeUrl("error"), 302);
    const authorization = await authorizationRepository.findById(state.authorizationId);
    if (
      !authorization ||
      !(await hasProjectManagerAccess({
        userId: authorization.userId,
        preferredOrgId: null,
        projectId: authorization.projectId,
      }))
    ) {
      return c.redirect(outcomeUrl("error"), 302);
    }
    try {
      await completeGcpAuthorization({
        authorizationId: state.authorizationId,
        code,
        repository: authorizationRepository,
        gateway,
      });
      return c.redirect(outcomeUrl("select", state.authorizationId), 302);
    } catch {
      return c.redirect(outcomeUrl("error"), 302);
    }
  });
}
