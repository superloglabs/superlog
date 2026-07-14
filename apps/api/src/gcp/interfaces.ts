import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { completeGcpConnect, startGcpConnect, type GcpApplicationConfig } from "./application.js";
import type { GcpConnectionRecord, GcpConnectionRepository, GcpGateway } from "./domain.js";
import { parseGcpProjectId } from "./domain.js";
import { GoogleGcpGateway } from "./google-gateway.js";
import { DrizzleGcpConnectionRepository } from "./repository.js";
import { signGcpState, verifyGcpState } from "./state.js";
import { resolveActiveOrgContext } from "../org-context.js";

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
    !pushAudience
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
} {
  const config = input.config !== undefined ? input.config : gcpConfigFromEnv();
  return {
    config,
    gateway: input.gateway ?? (config ? new GoogleGcpGateway(config) : null),
    repository: input.repository ?? new DrizzleGcpConnectionRepository(),
  };
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
  const { config, gateway, repository } = dependencies(input);
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/projects/:projectId/gcp/connection", async (c) => {
    const context = await requireProjectAccess(c, c.req.param("projectId"));
    return c.json(toPublic(await repository.findCurrent(context.projectId)));
  });

  app.post("/api/projects/:projectId/gcp/install-url", async (c) => {
    if (!config || !gateway || !stateSecret)
      return c.json({ error: "GCP connect not configured" }, 503);
    const context = await requireProjectAccess(c, c.req.param("projectId"));
    const body = (await c.req.json().catch(() => ({}))) as { gcpProjectId?: unknown };
    let gcpProjectId: string;
    try {
      gcpProjectId = parseGcpProjectId(body.gcpProjectId);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "invalid project id" }, 400);
    }
    const result = await startGcpConnect({
      ...context,
      gcpProjectId,
      repository,
      gateway,
      config,
      signState: (connectionId) => signGcpState(connectionId, stateSecret),
    });
    return c.json({ url: result.url });
  });
}

export function mountGcpPublic(app: Hono<{ Variables: Vars }>, input: Dependencies = {}): void {
  const { config, gateway, repository } = dependencies(input);
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/gcp/oauth/callback", async (c) => {
    if (!config || !gateway || !stateSecret)
      return c.json({ error: "GCP connect not configured" }, 503);
    const outcomeUrl = (outcome: "connected" | "denied" | "error") =>
      `${config.webOrigin}/connect/gcp?gcp=${outcome}`;
    if (c.req.query("error")) return c.redirect(outcomeUrl("denied"), 302);
    const code = c.req.query("code");
    const state = verifyGcpState(c.req.query("state") ?? "", stateSecret);
    if (!code || !state) return c.redirect(outcomeUrl("error"), 302);
    try {
      await completeGcpConnect({
        connectionId: state.connectionId,
        code,
        repository,
        gateway,
        config,
      });
      return c.redirect(outcomeUrl("connected"), 302);
    } catch {
      return c.redirect(outcomeUrl("error"), 302);
    }
  });
}
