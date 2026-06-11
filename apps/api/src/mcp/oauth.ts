import { createHash, randomBytes } from "node:crypto";
import {
  db,
  generateMcpAccessToken,
  generateMcpRefreshToken,
  hashToken,
  schema,
  syncLoopsContactForUserProject,
} from "@superlog/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "../logger.js";
import { resolveActiveOrgContext } from "../org-context.js";
import type { McpConfig } from "./config.js";

const log = logger.child({ scope: "mcp-oauth" });

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const CODE_TTL_SECONDS = 60 * 5;

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  receivedResources: string[];
  scope: string | null;
};

// Per RFC 8707 the resource indicator is compared by simple-string-comparison
// after canonicalization. We canonicalize by stripping trailing slashes and
// accept the API origin as an alias for the MCP endpoint, since several MCP
// clients in the wild derive the resource from the server's host rather than
// the MCP endpoint path. The stored value on issued tokens is always the
// canonical cfg.resource regardless of which alias the client sent.
//
// We also tolerate the resource indicator being entirely absent: some clients
// (e.g. Codex CLI as of 2026-05) don't propagate it from the protected-resource
// metadata into the authorize/token requests. In that case we fall back to
// cfg.resource — issued tokens are still bound server-side to that single
// resource, so the practical attack surface from confused-deputy redirection
// is unchanged. A *wrong* resource still hard-fails.
function normalizeResource(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function resourceMatches(value: string, cfg: McpConfig): boolean {
  const n = normalizeResource(value);
  if (!n) return false;
  return n === cfg.resource || n === cfg.apiBaseUrl;
}

function pickMatchingResource(values: string[], cfg: McpConfig): string | null {
  if (values.length === 0) return cfg.resource;
  for (const v of values) if (resourceMatches(v, cfg)) return cfg.resource;
  return null;
}

export function mountOauthMetadata(app: Hono, cfg: McpConfig) {
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: cfg.resource,
      authorization_servers: [cfg.apiBaseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:read"],
    }),
  );

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: cfg.apiBaseUrl,
      authorization_endpoint: `${cfg.apiBaseUrl}/oauth/authorize`,
      token_endpoint: `${cfg.apiBaseUrl}/oauth/token`,
      registration_endpoint: `${cfg.apiBaseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp:read"],
    }),
  );
}

export function mountOauthEndpoints(app: Hono, cfg: McpConfig) {
  app.post("/oauth/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      client_name?: string;
      redirect_uris?: unknown;
      token_endpoint_auth_method?: string;
    } | null;
    if (!body) return oauthError(c, 400, "invalid_client_metadata", "invalid JSON body");

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (redirectUris.length === 0) {
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris is required");
    }
    for (const uri of redirectUris) {
      if (!isValidRedirectUri(uri)) {
        return oauthError(c, 400, "invalid_redirect_uri", `invalid redirect_uri: ${uri}`);
      }
    }

    const tokenAuthMethod = body.token_endpoint_auth_method ?? "none";
    if (tokenAuthMethod !== "none") {
      return oauthError(
        c,
        400,
        "invalid_client_metadata",
        "only token_endpoint_auth_method=none is supported",
      );
    }

    const name = (body.client_name ?? "MCP client").slice(0, 200);
    const [client] = await db
      .insert(schema.mcpOauthClients)
      .values({ name, redirectUris, tokenEndpointAuthMethod: "none" })
      .returning();
    if (!client) throw new HTTPException(500, { message: "failed to register client" });

    return c.json({
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    });
  });

  app.get("/oauth/authorize", async (c) => {
    const params = readAuthorizeParams(c);
    const err = await validateAuthorizeParams(params, cfg);
    if (err) return oauthError(c, 400, err.code, err.description);

    const target = new URL(`${cfg.webOrigin}/oauth/consent`);
    target.searchParams.set("client_id", params.clientId);
    target.searchParams.set("redirect_uri", params.redirectUri);
    target.searchParams.set("code_challenge", params.codeChallenge);
    target.searchParams.set("code_challenge_method", params.codeChallengeMethod);
    target.searchParams.set("resource", params.resource);
    if (params.state) target.searchParams.set("state", params.state);
    if (params.scope) target.searchParams.set("scope", params.scope);
    return c.redirect(target.toString(), 302);
  });

  app.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody();
    const grantType = stringField(form, "grant_type");
    if (grantType === "authorization_code") {
      return handleCodeGrant(c, cfg, form);
    }
    if (grantType === "refresh_token") {
      return handleRefreshGrant(c, cfg, form);
    }
    return oauthError(c, 400, "unsupported_grant_type", `unsupported grant_type: ${grantType}`);
  });
}

export function mountOauthDecision(
  app: Hono<{ Variables: { userId: string; orgId: string | null } }>,
  cfg: McpConfig,
) {
  app.get("/api/mcp/oauth/client/:clientId", async (c) => {
    const clientId = c.req.param("clientId");
    const client = await db.query.mcpOauthClients.findFirst({
      where: eq(schema.mcpOauthClients.id, clientId),
    });
    if (!client) throw new HTTPException(404, { message: "client not found" });
    return c.json({ id: client.id, name: client.name });
  });

  app.post("/api/mcp/oauth/decision", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      client_id?: string;
      redirect_uri?: string;
      state?: string | null;
      code_challenge?: string;
      code_challenge_method?: string;
      resource?: string;
      scope?: string | null;
      project_id?: string;
      decision?: "allow" | "deny";
    } | null;
    if (!body) throw new HTTPException(400, { message: "invalid json" });

    const receivedResource = body.resource ?? "";
    const params: AuthorizeParams = {
      clientId: body.client_id ?? "",
      redirectUri: body.redirect_uri ?? "",
      state: body.state ?? null,
      codeChallenge: body.code_challenge ?? "",
      codeChallengeMethod: body.code_challenge_method ?? "",
      resource: receivedResource,
      receivedResources: receivedResource ? [receivedResource] : [],
      scope: body.scope ?? null,
    };
    const paramsErr = await validateAuthorizeParams(params, cfg);
    if (paramsErr) throw new HTTPException(400, { message: paramsErr.description });

    if (body.decision === "deny") {
      const redir = buildErrorRedirect(params, "access_denied", "user denied consent");
      return c.json({ redirect_uri: redir });
    }
    if (!body.project_id) throw new HTTPException(400, { message: "project_id is required" });

    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, body.project_id),
    });
    if (!project) throw new HTTPException(404, { message: "project not found" });

    const ctx = await resolveActiveOrgContext({
      userId: c.var.userId,
      preferredOrgId: c.var.orgId,
    }).catch(() => null);
    if (!ctx || ctx.org.id !== project.orgId) {
      throw new HTTPException(403, { message: "no access to project" });
    }
    const user = ctx.user;

    const code = randomBytes(32).toString("base64url");
    await db.insert(schema.mcpOauthCodes).values({
      code,
      clientId: params.clientId,
      userId: user.id,
      projectId: project.id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      resource: params.resource,
      scope: params.scope,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    });

    const url = new URL(params.redirectUri);
    url.searchParams.set("code", code);
    if (params.state) url.searchParams.set("state", params.state);
    return c.json({ redirect_uri: url.toString() });
  });
}

async function handleCodeGrant(c: Context, cfg: McpConfig, form: Record<string, string | File>) {
  const code = stringField(form, "code");
  const redirectUri = stringField(form, "redirect_uri");
  const codeVerifier = stringField(form, "code_verifier");
  const clientId = stringField(form, "client_id");
  const resource = stringField(form, "resource");

  if (!code || !redirectUri || !codeVerifier || !clientId) {
    return oauthError(c, 400, "invalid_request", "missing required parameters");
  }
  if (resource && !resourceMatches(resource, cfg)) {
    return oauthError(
      c,
      400,
      "invalid_target",
      `resource does not match MCP server; received: ${resource}`,
    );
  }

  const row = await db.query.mcpOauthCodes.findFirst({
    where: eq(schema.mcpOauthCodes.code, code),
  });
  if (!row) return oauthError(c, 400, "invalid_grant", "code not found");
  if (row.usedAt) return oauthError(c, 400, "invalid_grant", "code already used");
  if (row.expiresAt.getTime() < Date.now()) {
    return oauthError(c, 400, "invalid_grant", "code expired");
  }
  if (row.clientId !== clientId) return oauthError(c, 400, "invalid_grant", "client_id mismatch");
  if (row.redirectUri !== redirectUri) {
    return oauthError(c, 400, "invalid_grant", "redirect_uri mismatch");
  }
  if (!verifyPkce(codeVerifier, row.codeChallenge, row.codeChallengeMethod)) {
    return oauthError(c, 400, "invalid_grant", "PKCE verification failed");
  }

  await db
    .update(schema.mcpOauthCodes)
    .set({ usedAt: new Date() })
    .where(eq(schema.mcpOauthCodes.code, code));

  const tokens = await issueTokens({
    clientId: row.clientId,
    userId: row.userId,
    projectId: row.projectId,
    resource: row.resource,
    scope: row.scope,
  });
  return c.json(tokens);
}

async function handleRefreshGrant(c: Context, cfg: McpConfig, form: Record<string, string | File>) {
  const refreshToken = stringField(form, "refresh_token");
  const clientId = stringField(form, "client_id");
  const resource = stringField(form, "resource");
  if (!refreshToken || !clientId) {
    return oauthError(c, 400, "invalid_request", "missing refresh_token or client_id");
  }
  if (resource && !resourceMatches(resource, cfg)) {
    return oauthError(
      c,
      400,
      "invalid_target",
      `resource does not match MCP server; received: ${resource}`,
    );
  }

  const refreshHash = hashToken(refreshToken);
  const row = await db.query.mcpOauthTokens.findFirst({
    where: eq(schema.mcpOauthTokens.refreshHash, refreshHash),
  });
  if (!row) return oauthError(c, 400, "invalid_grant", "refresh token not found");
  if (row.revokedAt) return oauthError(c, 400, "invalid_grant", "refresh token revoked");
  if (row.clientId !== clientId) return oauthError(c, 400, "invalid_grant", "client_id mismatch");
  if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() < Date.now()) {
    return oauthError(c, 400, "invalid_grant", "refresh token expired");
  }

  await db
    .update(schema.mcpOauthTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.mcpOauthTokens.id, row.id));

  const tokens = await issueTokens({
    clientId: row.clientId,
    userId: row.userId,
    projectId: row.projectId,
    resource: row.resource,
    scope: row.scope,
  });
  return c.json(tokens);
}

async function issueTokens(params: {
  clientId: string;
  userId: string;
  projectId: string;
  resource: string;
  scope: string | null;
}): Promise<{
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope?: string;
}> {
  const access = generateMcpAccessToken();
  const refresh = generateMcpRefreshToken();
  await db.insert(schema.mcpOauthTokens).values({
    accessHash: access.hash,
    refreshHash: refresh.hash,
    clientId: params.clientId,
    userId: params.userId,
    projectId: params.projectId,
    resource: params.resource,
    scope: params.scope,
    accessExpiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
  });
  void syncLoopsContactForUserProject({
    userId: params.userId,
    projectId: params.projectId,
  }).catch((err) =>
    log.warn({ err, user_id: params.userId }, "loops contact sync failed after mcp install"),
  );
  return {
    access_token: access.plaintext,
    refresh_token: refresh.plaintext,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    ...(params.scope ? { scope: params.scope } : {}),
  };
}

function readAuthorizeParams(c: Context): AuthorizeParams {
  const q = c.req.query();
  // RFC 8707 allows the resource parameter to be repeated. c.req.query() only
  // returns the first occurrence, so use c.req.queries() to see them all.
  const received = c.req.queries("resource") ?? [];
  return {
    clientId: q.client_id ?? "",
    redirectUri: q.redirect_uri ?? "",
    state: q.state ?? null,
    codeChallenge: q.code_challenge ?? "",
    codeChallengeMethod: q.code_challenge_method ?? "",
    resource: received[0] ?? "",
    receivedResources: received,
    scope: q.scope ?? null,
  };
}

async function validateAuthorizeParams(
  params: AuthorizeParams,
  cfg: McpConfig,
): Promise<{ code: string; description: string } | null> {
  if (!params.clientId) return { code: "invalid_request", description: "client_id is required" };
  if (!params.redirectUri) {
    return { code: "invalid_request", description: "redirect_uri is required" };
  }
  if (params.codeChallengeMethod !== "S256") {
    return {
      code: "invalid_request",
      description: "code_challenge_method must be S256",
    };
  }
  if (!params.codeChallenge) {
    return { code: "invalid_request", description: "code_challenge is required" };
  }
  const matched = pickMatchingResource(params.receivedResources, cfg);
  if (!matched) {
    return {
      code: "invalid_target",
      description: `resource must be ${cfg.resource}; received: ${params.receivedResources.join(", ")}`,
    };
  }
  // Canonicalize so downstream storage always uses cfg.resource regardless of
  // which alias the client sent.
  params.resource = matched;
  const client = await db.query.mcpOauthClients.findFirst({
    where: eq(schema.mcpOauthClients.id, params.clientId),
  });
  if (!client) return { code: "invalid_request", description: "unknown client_id" };
  if (!client.redirectUris.includes(params.redirectUri)) {
    return { code: "invalid_request", description: "redirect_uri not registered" };
  }
  return null;
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return timingSafeEq(computed, challenge);
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Browser-executable or local-resource schemes that must never be redirect
// targets, even though they parse as URLs.
const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "blob:",
  "about:",
  "vbscript:",
]);

export function isValidRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  }
  // RFC 8252 §7.1: native apps (Cursor, VS Code, Claude Desktop, …) register
  // private-use URI schemes as their OAuth callbacks — e.g.
  // cursor://anysphere.cursor-mcp/oauth/callback. These are public clients;
  // PKCE S256 (enforced at authorize) plus exact redirect-URI matching against
  // the registered client are the safeguards, not the scheme.
  return !FORBIDDEN_REDIRECT_SCHEMES.has(u.protocol);
}

function buildErrorRedirect(params: AuthorizeParams, code: string, description: string): string {
  const url = new URL(params.redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  if (params.state) url.searchParams.set("state", params.state);
  return url.toString();
}

function stringField(form: Record<string, string | File>, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v : "";
}

function oauthError(c: Context, status: 400 | 401, code: string, description: string) {
  log.warn(
    {
      method: c.req.method,
      path: c.req.path,
      query: c.req.url.split("?")[1] ?? "",
      status,
      code,
      description,
    },
    "oauth error",
  );
  return c.json({ error: code, error_description: description }, status);
}
