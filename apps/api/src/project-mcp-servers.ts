import { randomBytes } from "node:crypto";
import {
  MAX_ENABLED_CUSTOM_MCP_SERVERS,
  type ProjectMcpServerAuth,
  ProjectMcpServerError,
  createDrizzleProjectMcpServerRepository,
  createProjectMcpServerManager,
  db,
  parseProjectMcpServerUrl,
  schema,
} from "@superlog/db";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { resolveActiveOrgContext } from "./org-context.js";
import {
  type ProjectMcpAuthDetection,
  detectProjectMcpAuth,
} from "./project-mcp-auth-detection.js";
import {
  createDrizzleProjectMcpOAuthAttemptStore,
  createFetchProjectMcpOAuthHttp,
  createProjectMcpOAuthService,
} from "./project-mcp-oauth.js";
import { testProjectMcpServerConnection } from "./project-mcp-test.js";

type Vars = { userId: string; orgId: string | null };
const repository = createDrizzleProjectMcpServerRepository();
const manager = createProjectMcpServerManager(repository);
const oauthHttp = createFetchProjectMcpOAuthHttp();
const oauth = createProjectMcpOAuthService({
  repository,
  attempts: createDrizzleProjectMcpOAuthAttemptStore(),
  http: oauthHttp,
});
const apiOrigin = (
  process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4100}`
).replace(/\/$/, "");
const oauthRedirectUri = `${apiOrigin}/api/agent-mcp-oauth/callback`;

export function mountProjectMcpServersAuthed(
  // biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
  app: Hono<any>,
  overrides: {
    detectAuth?: (url: string) => Promise<ProjectMcpAuthDetection>;
  } = {},
): void {
  const detectAuth =
    overrides.detectAuth ?? ((url: string) => detectProjectMcpAuth(url, oauthHttp));
  app.get("/api/org/projects/:projectId/agent-mcp-servers", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    const servers = await manager.list(scope.projectId);
    return c.json({
      servers,
      enabledCount: servers.filter((server) => server.enabled).length,
      enabledLimit: MAX_ENABLED_CUSTOM_MCP_SERVERS,
      canManage: scope.canManage,
    });
  });

  app.post("/api/org/projects/:projectId/agent-mcp-servers/detect-auth", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    if (!scope.canManage) return c.json({ error: "admin access required" }, 403);
    const body = await readBody(c);
    try {
      return c.json(await detectAuth(parseProjectMcpServerUrl(requiredString(body.url, "url"))));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/api/org/projects/:projectId/agent-mcp-servers", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    if (!scope.canManage) return c.json({ error: "admin access required" }, 403);
    const body = await readBody(c);
    try {
      const server = await manager.add({
        projectId: scope.projectId,
        actorUserId: scope.userId,
        name: requiredString(body.name, "name"),
        url: requiredString(body.url, "url"),
        enabled: optionalBoolean(body.enabled, "enabled"),
        auth: parseProjectMcpServerAuthInput(body.auth),
        confirmTrusted: body.confirmTrusted === true,
      });
      return c.json({ server }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.patch("/api/org/projects/:projectId/agent-mcp-servers/:id", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    if (!scope.canManage) return c.json({ error: "admin access required" }, 403);
    return updateServer(c, scope.projectId, scope.userId);
  });

  app.delete("/api/org/projects/:projectId/agent-mcp-servers/:id", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    if (!scope.canManage) return c.json({ error: "admin access required" }, 403);
    return removeServer(c, scope.projectId);
  });

  app.post("/api/org/projects/:projectId/agent-mcp-servers/:id/test", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    if (!scope.canManage) return c.json({ error: "admin access required" }, 403);
    return testServer(c, scope.projectId);
  });

  app.post("/api/org/projects/:projectId/agent-mcp-servers/:id/oauth/start", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    if (!scope.canManage) return c.json({ error: "admin access required" }, 403);
    return startOAuth(c, scope.projectId, scope.userId);
  });

  app.post(
    "/api/org/projects/:projectId/agent-mcp-servers/:id/oauth/client-credentials",
    async (c) => {
      const scope = await resolveProjectScope(c);
      if (!scope) return c.json({ error: "project not found" }, 404);
      if (!scope.canManage) return c.json({ error: "admin access required" }, 403);
      return connectClientCredentials(c, scope.projectId, scope.userId);
    },
  );

  app.post("/api/org/projects/:projectId/agent-mcp-servers/:id/oauth/disconnect", async (c) => {
    const scope = await resolveProjectScope(c);
    if (!scope) return c.json({ error: "project not found" }, 404);
    if (!scope.canManage) return c.json({ error: "admin access required" }, 403);
    return disconnectOAuth(c, scope.projectId, scope.userId);
  });
}

// Callback authentication is the single-use state + PKCE attempt, so this
// route must be mounted before the normal /api session middleware.
// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountProjectMcpOAuthPublic(app: Hono<any>): void {
  app.get("/api/agent-mcp-oauth/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const webOrigin = (process.env.WEB_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
    if (!state || !code || c.req.query("error")) {
      return c.redirect(`${webOrigin}/settings?section=agent-mcps&mcp_oauth=error`);
    }
    try {
      const server = await oauth.complete({ state, code });
      const target = new URL(`${webOrigin}/settings`);
      target.searchParams.set("section", "agent-mcps");
      target.searchParams.set("projectId", server.projectId);
      target.searchParams.set("mcp_oauth", "connected");
      return c.redirect(target.toString());
    } catch {
      return c.redirect(`${webOrigin}/settings?section=agent-mcps&mcp_oauth=error`);
    }
  });
}

// Mounted after the management-key middleware registered by management.ts.
// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountProjectMcpServersManagement(app: Hono<any>): void {
  app.get("/api/v1/projects/:projectId/agent-mcp-servers", async (c) => {
    const projectId = await resolveManagementProject(c);
    if (!projectId) return c.json({ error: "project not found" }, 404);
    const servers = await manager.list(projectId);
    return c.json({
      servers,
      enabledCount: servers.filter((server) => server.enabled).length,
      enabledLimit: MAX_ENABLED_CUSTOM_MCP_SERVERS,
    });
  });

  app.post("/api/v1/projects/:projectId/agent-mcp-servers", async (c) => {
    const projectId = await resolveManagementProject(c);
    if (!projectId) return c.json({ error: "project not found" }, 404);
    const body = await readBody(c);
    try {
      const server = await manager.add({
        projectId,
        actorUserId: null,
        name: requiredString(body.name, "name"),
        url: requiredString(body.url, "url"),
        enabled: optionalBoolean(body.enabled, "enabled"),
        auth: parseProjectMcpServerAuthInput(body.auth),
        confirmTrusted: body.confirmTrusted === true,
      });
      return c.json({ server }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.patch("/api/v1/projects/:projectId/agent-mcp-servers/:id", async (c) => {
    const projectId = await resolveManagementProject(c);
    if (!projectId) return c.json({ error: "project not found" }, 404);
    return updateServer(c, projectId, null);
  });

  app.delete("/api/v1/projects/:projectId/agent-mcp-servers/:id", async (c) => {
    const projectId = await resolveManagementProject(c);
    if (!projectId) return c.json({ error: "project not found" }, 404);
    return removeServer(c, projectId);
  });

  app.post("/api/v1/projects/:projectId/agent-mcp-servers/:id/test", async (c) => {
    const projectId = await resolveManagementProject(c);
    if (!projectId) return c.json({ error: "project not found" }, 404);
    return testServer(c, projectId);
  });

  app.post("/api/v1/projects/:projectId/agent-mcp-servers/:id/oauth/start", async (c) => {
    const projectId = await resolveManagementProject(c);
    if (!projectId) return c.json({ error: "project not found" }, 404);
    return startOAuth(c, projectId, null);
  });

  app.post(
    "/api/v1/projects/:projectId/agent-mcp-servers/:id/oauth/client-credentials",
    async (c) => {
      const projectId = await resolveManagementProject(c);
      if (!projectId) return c.json({ error: "project not found" }, 404);
      return connectClientCredentials(c, projectId, null);
    },
  );

  app.post("/api/v1/projects/:projectId/agent-mcp-servers/:id/oauth/disconnect", async (c) => {
    const projectId = await resolveManagementProject(c);
    if (!projectId) return c.json({ error: "project not found" }, 404);
    return disconnectOAuth(c, projectId, null);
  });
}

async function startOAuth(c: Context, projectId: string, actorUserId: string | null) {
  try {
    const result = await oauth.start({
      projectId,
      serverId: requiredParam(c, "id"),
      actorUserId,
      redirectUri: oauthRedirectUri,
    });
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "OAuth start failed" }, 400);
  }
}

async function testServer(c: Context, projectId: string) {
  try {
    return c.json(
      await testProjectMcpServerConnection({
        projectId,
        serverId: requiredParam(c, "id"),
        repository,
        ensureFreshOAuth: async (targetProjectId, serverId) =>
          oauth.ensureFresh({ projectId: targetProjectId, serverId }),
      }),
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "MCP connection test failed",
      },
      400,
    );
  }
}

async function connectClientCredentials(c: Context, projectId: string, actorUserId: string | null) {
  try {
    const server = await oauth.connectClientCredentials({
      projectId,
      serverId: requiredParam(c, "id"),
      actorUserId,
    });
    return c.json({
      server: await manager
        .list(projectId)
        .then((servers) => servers.find((candidate) => candidate.id === server.id)),
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "OAuth connection failed",
      },
      400,
    );
  }
}

async function disconnectOAuth(c: Context, projectId: string, actorUserId: string | null) {
  const server = await repository.get(projectId, requiredParam(c, "id"));
  if (!server) return c.json({ error: "MCP server not found" }, 404);
  if (server.auth.type !== "oauth") return c.json({ error: "server does not use OAuth" }, 400);
  await repository.update({
    ...server,
    enabled: false,
    auth: {
      ...server.auth,
      status: "pending",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    },
    updatedByUserId: actorUserId,
    updatedAt: new Date(),
  });
  return c.json({ ok: true });
}

async function updateServer(c: Context, projectId: string, actorUserId: string | null) {
  const body = await readBody(c);
  try {
    const server = await manager.update({
      projectId,
      id: requiredParam(c, "id"),
      actorUserId,
      name: body.name === undefined ? undefined : requiredString(body.name, "name"),
      url: body.url === undefined ? undefined : requiredString(body.url, "url"),
      enabled: optionalBoolean(body.enabled, "enabled"),
      auth: body.auth === undefined ? undefined : parseProjectMcpServerAuthInput(body.auth),
      confirmTrusted: optionalBoolean(body.confirmTrusted, "confirmTrusted"),
    });
    return c.json({ server });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function removeServer(c: Context, projectId: string) {
  try {
    await manager.remove(projectId, requiredParam(c, "id"));
    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
}

export function parseProjectMcpServerAuthInput(value: unknown): ProjectMcpServerAuth {
  if (value === undefined) return { type: "none" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectMcpServerError("invalid_auth", "auth must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.type === "none") return { type: "none" };
  if (input.type === "bearer") {
    return { type: "bearer", token: requiredString(input.token, "auth.token") };
  }
  if (input.type === "api_key") {
    return {
      type: "api_key",
      headerName: requiredString(input.headerName, "auth.headerName"),
      key: requiredString(input.key, "auth.key"),
      relayToken: randomBytes(32).toString("base64url"),
    };
  }
  if (input.type === "oauth") {
    const grantType = input.grantType ?? "authorization_code";
    if (grantType !== "authorization_code" && grantType !== "client_credentials") {
      throw new ProjectMcpServerError("invalid_auth", "unsupported OAuth grant type");
    }
    return {
      type: "oauth",
      grantType,
      status: "pending",
      scopes: Array.isArray(input.scopes)
        ? input.scopes.filter((scope): scope is string => typeof scope === "string")
        : [],
      clientId: optionalString(input.clientId),
      clientSecret: optionalString(input.clientSecret),
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      tokenEndpoint: null,
      authorizationServer: null,
      resource: null,
    };
  }
  throw new ProjectMcpServerError("invalid_auth", "unsupported authentication type");
}

async function resolveProjectScope(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; projectId: string; canManage: boolean } | null> {
  const userId = c.var.userId;
  const ctx = await resolveActiveOrgContext({
    userId,
    preferredOrgId: c.var.orgId,
  }).catch(() => null);
  if (!ctx) return null;
  const projectId = requiredParam(c, "projectId");
  const project = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, ctx.org.id)),
    columns: { id: true },
  });
  if (!project) return null;
  const member = await db.query.orgMembers.findFirst({
    where: and(eq(schema.orgMembers.orgId, ctx.org.id), eq(schema.orgMembers.userId, userId)),
    columns: { role: true },
  });
  return {
    userId,
    projectId,
    canManage: member?.role === "owner" || member?.role === "admin",
  };
}

async function resolveManagementProject(c: Context): Promise<string | null> {
  const orgId = (c.var as { managementOrgId?: string }).managementOrgId;
  if (!orgId) return null;
  const projectId = requiredParam(c, "projectId");
  const project = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, orgId)),
    columns: { id: true },
  });
  return project?.id ?? null;
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectMcpServerError("invalid_auth", `${field} must be a non-empty string`);
  }
  return value;
}

function requiredParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new ProjectMcpServerError("not_found", `${name} is required`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProjectMcpServerError("invalid_auth", `${field} must be a boolean`);
  }
  return value;
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ProjectMcpServerError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code.startsWith("duplicate_") || error.code === "enabled_limit"
          ? 409
          : 400;
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return c.json({ error: "an MCP server with that name or URL already exists" }, 409);
  }
  throw error;
}
