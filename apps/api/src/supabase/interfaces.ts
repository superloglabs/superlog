import {
  SupabaseManagementClient,
  buildSupabaseAuthorizeUrl,
  supabaseConfigFromEnv,
} from "@superlog/supabase";
import type { Hono } from "hono";
import { signState, verifyState } from "../oauth-state.js";
import { requireProjectManagerContext } from "../org-authorization-http.js";
import { hasProjectManagerAccess } from "../org-authorization.js";
import { buildAppWebUrl } from "../project-web-route.js";
import { completeSupabaseOAuth, connectSupabaseProjects } from "./application.js";
import { ManagedSupabaseGateway } from "./gateway.js";
import { DrizzleSupabaseRepository } from "./repository.js";

type Vars = { userId: string; orgId: string | null };

const repository = new DrizzleSupabaseRepository();

type SupabaseRouteDeps = {
  repository?: DrizzleSupabaseRepository;
  client?: SupabaseManagementClient;
};

function routeContext(deps: SupabaseRouteDeps = {}) {
  const config = supabaseConfigFromEnv();
  const repo = deps.repository ?? repository;
  const client = deps.client ?? new SupabaseManagementClient();
  const stateSecret = process.env.STATE_SIGNING_SECRET ?? "";
  const configured = Boolean(config && stateSecret && process.env.AGENT_SECRETS_KEY);
  const gateway = config && configured ? new ManagedSupabaseGateway(repo, client, config) : null;
  return {
    config,
    configured,
    repository: repo,
    client,
    gateway,
    stateSecret,
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  };
}

export function mountSupabaseAuthed(app: Hono<{ Variables: Vars }>, deps: SupabaseRouteDeps = {}) {
  const context = routeContext(deps);

  app.get("/api/projects/:projectId/supabase", async (c) => {
    const scope = await requireProjectManagerContext(c, c.req.param("projectId"));
    const [grants, connections] = await Promise.all([
      context.repository.listGrants(scope.project.orgId),
      context.repository.listConnections(scope.project.id),
    ]);
    return c.json({
      configured: context.configured,
      canManage: true,
      grants: grants.map((grant) => ({
        id: grant.id,
        primaryEmail: grant.primaryEmail,
        username: grant.username,
        tokenExpiresAt: grant.tokenExpiresAt?.toISOString() ?? null,
      })),
      connections: connections.map((connection) => ({
        ...connection,
        lastPolledAt: connection.lastPolledAt?.toISOString() ?? null,
        lastMetricsReceivedAt: connection.lastMetricsReceivedAt?.toISOString() ?? null,
      })),
    });
  });

  app.post("/api/projects/:projectId/supabase/install-url", async (c) => {
    if (!context.configured || !context.config) {
      return c.json({ error: "Supabase connect not configured" }, 503);
    }
    const scope = await requireProjectManagerContext(c, c.req.param("projectId"));
    const state = signState(
      {
        orgId: scope.project.orgId,
        projectId: scope.project.id,
        userId: scope.access.userId,
      },
      context.stateSecret,
    );
    return c.json({
      url: buildSupabaseAuthorizeUrl({
        clientId: context.config.clientId,
        redirectUri: context.config.redirectUri,
        state,
      }),
    });
  });

  app.get("/api/projects/:projectId/supabase/grants/:grantId/projects", async (c) => {
    if (!context.gateway) return c.json({ error: "Supabase connect not configured" }, 503);
    const scope = await requireProjectManagerContext(c, c.req.param("projectId"));
    const grant = await context.repository.findGrant(scope.project.orgId, c.req.param("grantId"));
    if (!grant || grant.revokedAt) return c.json({ error: "Supabase grant not found" }, 404);
    return c.json({ projects: await context.gateway.listProjects(grant.id) });
  });

  app.post("/api/projects/:projectId/supabase/connections", async (c) => {
    if (!context.gateway) return c.json({ error: "Supabase connect not configured" }, 503);
    const scope = await requireProjectManagerContext(c, c.req.param("projectId"));
    const body = (await c.req.json().catch(() => ({}))) as {
      grantId?: unknown;
      connections?: unknown;
    };
    if (typeof body.grantId !== "string" || !Array.isArray(body.connections)) {
      return c.json({ error: "grantId and connections are required" }, 400);
    }
    try {
      const connections = await connectSupabaseProjects({
        orgId: scope.project.orgId,
        projectId: scope.project.id,
        grantId: body.grantId,
        actorUserId: scope.access.userId,
        selections: body.connections as Array<{ projectRef: string; environment: string }>,
        repository: context.repository,
        gateway: context.gateway,
      });
      return c.json({ connections }, 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Supabase connect failed" },
        400,
      );
    }
  });

  app.delete("/api/projects/:projectId/supabase/connections/:connectionId", async (c) => {
    const scope = await requireProjectManagerContext(c, c.req.param("projectId"));
    const removed = await context.repository.revokeConnection(
      scope.project.id,
      c.req.param("connectionId"),
    );
    return removed ? c.json({ ok: true }) : c.json({ error: "Supabase connection not found" }, 404);
  });

  app.delete("/api/projects/:projectId/supabase/grants/:grantId", async (c) => {
    const scope = await requireProjectManagerContext(c, c.req.param("projectId"));
    const removed = await context.repository.revokeGrant(
      scope.project.orgId,
      c.req.param("grantId"),
    );
    return removed ? c.json({ ok: true }) : c.json({ error: "Supabase grant not found" }, 404);
  });
}

export function mountSupabasePublic(app: Hono<{ Variables: Vars }>, deps: SupabaseRouteDeps = {}) {
  const context = routeContext(deps);
  app.get("/supabase/oauth/callback", async (c) => {
    const outcome = (status: "connected" | "denied" | "error", grantId?: string) => {
      const url = new URL(buildAppWebUrl(context.webOrigin, "/settings"));
      url.searchParams.set("section", "integrations");
      url.searchParams.set("supabase", status);
      if (grantId) url.searchParams.set("supabase_grant", grantId);
      return url.toString();
    };
    if (c.req.query("error")) return c.redirect(outcome("denied"), 302);
    if (!context.configured || !context.config || !context.gateway) {
      return c.redirect(outcome("error"), 302);
    }
    const state = verifyState(c.req.query("state") ?? "", context.stateSecret);
    const code = c.req.query("code");
    if (!state?.userId || !code) return c.redirect(outcome("error"), 302);
    const allowed = await hasProjectManagerAccess({
      userId: state.userId,
      preferredOrgId: state.orgId,
      projectId: state.projectId,
    });
    if (!allowed) return c.redirect(outcome("error"), 302);
    try {
      const grant = await completeSupabaseOAuth({
        orgId: state.orgId,
        actorUserId: state.userId,
        code,
        repository: context.repository,
        gateway: context.gateway,
      });
      return c.redirect(outcome("connected", grant.id), 302);
    } catch {
      return c.redirect(outcome("error"), 302);
    }
  });
}
