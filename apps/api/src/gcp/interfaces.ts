import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "../logger.js";
import { requireProjectManagerContext } from "../org-authorization-http.js";
import { hasProjectManagerAccess } from "../org-authorization.js";
import { resolveActiveOrgContext } from "../org-context.js";
import {
  type GcpApplicationConfig,
  GcpLogExclusionError,
  MAX_GCP_LOG_EXCLUSIONS,
  updateGcpLogExclusions,
} from "./application.js";
import {
  completeGcpAuthorization,
  connectGcpAuthorization,
  disconnectGcpAuthorization,
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
import { GCP_AUTHORIZATION_TTL_MS, GcpAuthorizationError } from "./domain.js";
import { GoogleGcpGateway } from "./google-gateway.js";
import { DrizzleGcpConnectionRepository } from "./repository.js";
import { signGcpState, verifyGcpState } from "./state.js";

type Vars = { userId: string; orgId: string | null };

const GCP_SETUP_FAILED_MESSAGE = "Google Cloud setup failed. Please try again or contact support.";
const gcpLog = logger.child({ scope: "gcp" });

type GcpConnectLog = {
  error(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
};

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
  log?: GcpConnectLog;
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
  log: GcpConnectLog;
} {
  const config = input.config !== undefined ? input.config : gcpConfigFromEnv();
  return {
    config,
    gateway: input.gateway ?? (config ? new GoogleGcpGateway(config) : null),
    repository: input.repository ?? new DrizzleGcpConnectionRepository(),
    authorizationRepository:
      input.authorizationRepository ?? new DrizzleGcpAuthorizationRepository(),
    log: input.log ?? gcpLog,
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

function toPublic(connection: GcpConnectionRecord | null, canManage: boolean) {
  if (!connection) return { connected: false as const, canManage };
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
    excludedLogNames: connection.excludedLogNames,
    metricsBudgetMonth: connection.metricsBudgetMonth,
    metricsSeriesRead: connection.metricsSeriesRead,
    metricsMonthlySeriesLimit: monthlySeriesLimit(),
    lastError: connection.lastError ? GCP_SETUP_FAILED_MESSAGE : null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    canManage,
    maxLogExclusions: MAX_GCP_LOG_EXCLUSIONS,
  };
}

export function mountGcpAuthed(app: Hono<{ Variables: Vars }>, input: Dependencies = {}): void {
  const { config, gateway, repository, authorizationRepository, log } = dependencies(input);
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/projects/:projectId/gcp/connection", async (c) => {
    const context = await requireProjectAccess(c, c.req.param("projectId"));
    const canManage = await hasProjectManagerAccess({
      userId: context.userId,
      preferredOrgId: c.var.orgId,
      projectId: context.projectId,
    });
    return c.json(toPublic(await repository.findCurrent(context.projectId), canManage));
  });

  app.patch("/api/projects/:projectId/gcp/log-exclusions", async (c) => {
    const context = await requireProjectManager(c, c.req.param("projectId"));
    const parsedBody: unknown = await c.req.json().catch(() => ({}));
    const body =
      parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
        ? (parsedBody as { excludedLogNames?: unknown })
        : {};
    try {
      const connection = await updateGcpLogExclusions({
        projectId: context.projectId,
        excludedLogNames: body.excludedLogNames,
        repository,
      });
      log.info(
        {
          projectId: context.projectId,
          userId: context.userId,
          gcpConnectionId: connection.id,
          excludedLogNames: connection.excludedLogNames,
        },
        "GCP log exclusions updated",
      );
      return c.json(toPublic(connection, true));
    } catch (error) {
      if (error instanceof GcpLogExclusionError) {
        if (error.code === "not_found") {
          log.info(
            { projectId: context.projectId, userId: context.userId },
            "GCP log exclusions update skipped: connected project not found",
          );
        }
        return c.json({ error: error.message }, error.code === "not_found" ? 404 : 400);
      }
      log.error(
        { err: error, projectId: context.projectId, userId: context.userId },
        "Failed to update GCP log exclusions",
      );
      return c.json({ error: "Failed to update GCP log exclusions" }, 500);
    }
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

  app.post("/api/projects/:projectId/gcp/disconnect-url", async (c) => {
    if (!config || !gateway || !stateSecret)
      return c.json({ error: "GCP connect not configured" }, 503);
    const context = await requireProjectManager(c, c.req.param("projectId"));
    const connection = await repository.findCurrent(context.projectId);
    if (!connection || connection.status !== "connected" || connection.revokedAt) {
      return c.json({ error: "Connected GCP project not found" }, 404);
    }
    const result = await startGcpAuthorization({
      ...context,
      repository: authorizationRepository,
      gateway,
      signState: (authorizationId) =>
        signGcpState(authorizationId, stateSecret, Date.now(), {
          action: "disconnect",
          connectionId: connection.id,
        }),
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
    const authorizationId = c.req.param("authorizationId");
    const body = (await c.req.json().catch(() => ({}))) as { gcpProjectId?: unknown };
    try {
      const session = await getGcpAuthorizationSelection({
        authorizationId,
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
      log.error(
        {
          err: error,
          authorizationId,
          gcpProjectId: body.gcpProjectId,
        },
        "Google Cloud provisioning failed",
      );
      return c.json({ error: GCP_SETUP_FAILED_MESSAGE }, 502);
    }
  });

  app.post("/api/gcp/authorizations/:authorizationId/disconnect", async (c) => {
    if (!config || !gateway || !stateSecret)
      return c.json({ error: "GCP connect not configured" }, 503);
    if (!c.var.userId) return c.json({ error: "unauthenticated" }, 401);
    const authorizationId = c.req.param("authorizationId");
    const parsedBody: unknown = await c.req.json().catch(() => ({}));
    const authorizationState =
      parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
        ? (parsedBody as { authorizationState?: unknown }).authorizationState
        : undefined;
    const disconnectIntent =
      typeof authorizationState === "string"
        ? verifyGcpState(authorizationState, stateSecret)
        : null;
    if (
      !disconnectIntent ||
      disconnectIntent.action !== "disconnect" ||
      disconnectIntent.authorizationId !== authorizationId ||
      !disconnectIntent.connectionId
    ) {
      return c.json({ error: "Invalid Google Cloud disconnect authorization" }, 400);
    }
    try {
      const session = await getGcpAuthorizationSelection({
        authorizationId,
        userId: c.var.userId,
        repository: authorizationRepository,
      });
      const context = await requireProjectManager(c, session.projectId);
      const connection = await disconnectGcpAuthorization({
        authorizationId: session.id,
        userId: c.var.userId,
        expectedConnectionId: disconnectIntent.connectionId,
        authorizationRepository,
        connectionRepository: repository,
        gateway,
        config,
      });
      log.info(
        {
          projectId: context.projectId,
          userId: context.userId,
          gcpConnectionId: connection.id,
          gcpProjectId: connection.gcpProjectId,
        },
        "Google Cloud connection disconnected",
      );
      return c.json({ disconnected: true as const });
    } catch (error) {
      if (error instanceof GcpAuthorizationError) {
        return c.json({ error: error.message }, authorizationErrorStatus(error));
      }
      log.error(
        { err: error, authorizationId, userId: c.var.userId },
        "Google Cloud disconnection failed",
      );
      return c.json({ error: "Google Cloud disconnect failed. Please try again." }, 502);
    }
  });
}

export function mountGcpPublic(app: Hono<{ Variables: Vars }>, input: Dependencies = {}): void {
  const { config, gateway, authorizationRepository } = dependencies(input);
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/gcp/oauth/callback", async (c) => {
    if (!config || !gateway || !stateSecret)
      return c.json({ error: "GCP connect not configured" }, 503);
    const outcomeUrl = (
      outcome: "select" | "denied" | "error",
      authorizationId?: string,
      authorizationState?: string,
    ) => {
      const url = new URL("/connect/gcp", config.webOrigin);
      url.searchParams.set("gcp", outcome);
      if (authorizationId) url.searchParams.set("authorization", authorizationId);
      if (authorizationState) {
        url.searchParams.set("action", "disconnect");
        url.searchParams.set("authorization_state", authorizationState);
      }
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
    const stateParam = c.req.query("state") ?? "";
    const state = verifyGcpState(stateParam, stateSecret);
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
      const completed = await completeGcpAuthorization({
        authorizationId: state.authorizationId,
        code,
        repository: authorizationRepository,
        gateway,
      });
      const refreshedDisconnectState =
        state.action === "disconnect" && state.connectionId
          ? signGcpState(
              state.authorizationId,
              stateSecret,
              completed.expiresAt.getTime() - GCP_AUTHORIZATION_TTL_MS,
              { action: "disconnect", connectionId: state.connectionId },
            )
          : undefined;
      return c.redirect(outcomeUrl("select", state.authorizationId, refreshedDisconnectState), 302);
    } catch {
      return c.redirect(outcomeUrl("error"), 302);
    }
  });
}
