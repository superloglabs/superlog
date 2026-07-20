import { createHash, randomBytes } from "node:crypto";
import type { ProjectMcpServer, ProjectMcpServerRepository } from "@superlog/db";
import { db, decryptIntegrationSecret, encryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import { strictProjectMcpFetch } from "./project-mcp-http.js";

const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export type ProjectMcpOAuthDiscovery = {
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  resource: string;
  codeChallengeMethods: string[];
  grantTypes: string[];
  // Scopes the server advertises for this resource in RFC 9728
  // protected-resource metadata. A read-only URL can therefore advertise only
  // read scopes, which the client requests unless the operator pins a subset.
  scopesSupported: string[];
};

export type ProjectMcpOAuthAttempt = {
  projectId: string;
  serverId: string;
  serverUrl: string;
  stateHash: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  authorizationServer: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
};

export type ProjectMcpOAuthTokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
  scope: string | null;
};

export type ProjectMcpOAuthAttemptStore = {
  create(attempt: ProjectMcpOAuthAttempt): Promise<void>;
  consume(state: string): Promise<ProjectMcpOAuthAttempt | null>;
};

export type ProjectMcpOAuthHttp = {
  discover(serverUrl: string, signal?: AbortSignal): Promise<ProjectMcpOAuthDiscovery>;
  register(
    registrationEndpoint: string,
    redirectUri: string,
    scopes: string[],
  ): Promise<{ clientId: string; clientSecret: string | null }>;
  exchange(input: {
    tokenEndpoint: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string | null;
    resource: string;
  }): Promise<ProjectMcpOAuthTokenResponse>;
  refresh(input: {
    tokenEndpoint: string;
    refreshToken: string;
    clientId: string;
    clientSecret: string | null;
    resource: string;
    scopes: string[];
  }): Promise<ProjectMcpOAuthTokenResponse>;
  clientCredentials(input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    resource: string;
    scopes: string[];
  }): Promise<ProjectMcpOAuthTokenResponse>;
};

export function createProjectMcpOAuthService(deps: {
  repository: Pick<ProjectMcpServerRepository, "get" | "update">;
  attempts: ProjectMcpOAuthAttemptStore;
  http: ProjectMcpOAuthHttp;
  randomToken?: () => string;
  now?: () => Date;
}) {
  const randomToken = deps.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const now = deps.now ?? (() => new Date());

  return {
    async start(input: {
      projectId: string;
      serverId: string;
      actorUserId: string | null;
      redirectUri: string;
    }): Promise<{ authorizationUrl: string; expiresAt: string }> {
      const server = await requireOAuthServer(deps.repository, input.projectId, input.serverId);
      if (server.auth.grantType !== "authorization_code") {
        throw new Error("this OAuth server uses the client credentials grant");
      }
      const discovery = await deps.http.discover(server.url);
      if (!discovery.codeChallengeMethods.includes("S256")) {
        throw new Error("OAuth server does not advertise PKCE S256 support");
      }
      // An operator-pinned scope list wins; otherwise request everything the
      // server advertises for this resource. This is what makes a read-only
      // resource URL request only read scopes, matching other MCP clients,
      // instead of falling through to the server's "grant everything" default.
      const requestedScopes =
        server.auth.scopes.length > 0 ? server.auth.scopes : discovery.scopesSupported;
      let clientId = server.auth.clientId;
      let clientSecret = server.auth.clientSecret;
      let persistedScopes = server.auth.scopes;
      if (!clientId) {
        if (!discovery.registrationEndpoint) {
          throw new Error(
            "OAuth client ID is required because dynamic registration is unavailable",
          );
        }
        const registration = await deps.http.register(
          discovery.registrationEndpoint,
          input.redirectUri,
          requestedScopes,
        );
        clientId = registration.clientId;
        clientSecret = registration.clientSecret;
        persistedScopes = requestedScopes;
      }
      const state = randomToken();
      const codeVerifier = randomToken();
      const expiresAt = new Date(now().getTime() + OAUTH_ATTEMPT_TTL_MS);
      await deps.attempts.create({
        projectId: input.projectId,
        serverId: input.serverId,
        serverUrl: server.url,
        stateHash: sha256(state),
        codeVerifier,
        redirectUri: input.redirectUri,
        clientId,
        clientSecret,
        tokenEndpoint: discovery.tokenEndpoint,
        authorizationServer: discovery.authorizationServer,
        resource: discovery.resource,
        scopes: requestedScopes,
        expiresAt,
      });
      await deps.repository.update({
        ...server,
        auth: {
          ...server.auth,
          status: "pending",
          clientId,
          clientSecret,
          scopes: persistedScopes,
          tokenEndpoint: discovery.tokenEndpoint,
          authorizationServer: discovery.authorizationServer,
          resource: discovery.resource,
        },
        updatedByUserId: input.actorUserId,
        updatedAt: now(),
      });
      const authorizationUrl = new URL(discovery.authorizationEndpoint);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", clientId);
      authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      authorizationUrl.searchParams.set("resource", discovery.resource);
      if (requestedScopes.length > 0) {
        authorizationUrl.searchParams.set("scope", requestedScopes.join(" "));
      }
      return {
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: expiresAt.toISOString(),
      };
    },

    async complete(input: {
      state: string;
      code: string;
    }): Promise<ProjectMcpServer> {
      const attempt = await deps.attempts.consume(input.state);
      if (!attempt || attempt.expiresAt <= now())
        throw new Error("OAuth attempt is invalid or expired");
      const server = await requireOAuthServer(deps.repository, attempt.projectId, attempt.serverId);
      if (server.url !== attempt.serverUrl) {
        throw new Error("OAuth server configuration changed after authorization started");
      }
      const token = await deps.http.exchange({
        tokenEndpoint: attempt.tokenEndpoint,
        code: input.code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: attempt.redirectUri,
        clientId: attempt.clientId,
        clientSecret: attempt.clientSecret,
        resource: attempt.resource,
      });
      return deps.repository.update({
        ...server,
        auth: {
          ...server.auth,
          status: "connected",
          clientId: attempt.clientId,
          clientSecret: attempt.clientSecret,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt:
            token.expiresInSeconds === null
              ? null
              : new Date(now().getTime() + token.expiresInSeconds * 1000),
          tokenEndpoint: attempt.tokenEndpoint,
          authorizationServer: attempt.authorizationServer,
          resource: attempt.resource,
          scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : attempt.scopes,
        },
        updatedAt: now(),
      });
    },

    async ensureFresh(input: {
      projectId: string;
      serverId: string;
    }): Promise<ProjectMcpServer> {
      const server = await requireOAuthServer(deps.repository, input.projectId, input.serverId);
      if (
        server.auth.accessToken &&
        (!server.auth.expiresAt || server.auth.expiresAt.getTime() > now().getTime() + 60_000)
      ) {
        return server;
      }
      if (server.auth.grantType === "client_credentials") {
        return connectClientCredentials(server, null);
      }
      if (
        !server.auth.refreshToken ||
        !server.auth.tokenEndpoint ||
        !server.auth.clientId ||
        !server.auth.resource
      ) {
        throw new Error("OAuth connection has expired and cannot be refreshed");
      }
      const token = await deps.http.refresh({
        tokenEndpoint: server.auth.tokenEndpoint,
        refreshToken: server.auth.refreshToken,
        clientId: server.auth.clientId,
        clientSecret: server.auth.clientSecret,
        resource: server.auth.resource,
        scopes: server.auth.scopes,
      });
      return storeToken(server, token, {
        refreshToken: token.refreshToken ?? server.auth.refreshToken,
      });
    },

    async connectClientCredentials(input: {
      projectId: string;
      serverId: string;
      actorUserId: string | null;
    }): Promise<ProjectMcpServer> {
      const server = await requireOAuthServer(deps.repository, input.projectId, input.serverId);
      return connectClientCredentials(server, input.actorUserId);
    },
  };

  async function connectClientCredentials(
    server: ProjectMcpServer & {
      auth: Extract<ProjectMcpServer["auth"], { type: "oauth" }>;
    },
    actorUserId: string | null,
  ): Promise<ProjectMcpServer> {
    if (server.auth.grantType !== "client_credentials") {
      throw new Error("this OAuth server uses the authorization code grant");
    }
    if (!server.auth.clientId || !server.auth.clientSecret) {
      throw new Error("OAuth client credentials requires a client ID and client secret");
    }
    const discovery = await deps.http.discover(server.url);
    if (!discovery.grantTypes.includes("client_credentials")) {
      throw new Error("OAuth server does not advertise the client credentials grant");
    }
    const requestedScopes =
      server.auth.scopes.length > 0 ? server.auth.scopes : discovery.scopesSupported;
    const token = await deps.http.clientCredentials({
      tokenEndpoint: discovery.tokenEndpoint,
      clientId: server.auth.clientId,
      clientSecret: server.auth.clientSecret,
      resource: discovery.resource,
      scopes: requestedScopes,
    });
    return storeToken(server, token, {
      actorUserId,
      tokenEndpoint: discovery.tokenEndpoint,
      authorizationServer: discovery.authorizationServer,
      resource: discovery.resource,
      scopes: requestedScopes,
    });
  }

  async function storeToken(
    server: ProjectMcpServer & {
      auth: Extract<ProjectMcpServer["auth"], { type: "oauth" }>;
    },
    token: ProjectMcpOAuthTokenResponse,
    overrides: {
      actorUserId?: string | null;
      refreshToken?: string | null;
      tokenEndpoint?: string;
      authorizationServer?: string;
      resource?: string;
      scopes?: string[];
    } = {},
  ): Promise<ProjectMcpServer> {
    return deps.repository.update({
      ...server,
      auth: {
        ...server.auth,
        status: "connected",
        accessToken: token.accessToken,
        refreshToken: overrides.refreshToken ?? token.refreshToken,
        expiresAt:
          token.expiresInSeconds === null
            ? null
            : new Date(now().getTime() + token.expiresInSeconds * 1000),
        tokenEndpoint: overrides.tokenEndpoint ?? server.auth.tokenEndpoint,
        authorizationServer: overrides.authorizationServer ?? server.auth.authorizationServer,
        resource: overrides.resource ?? server.auth.resource,
        scopes: token.scope
          ? token.scope.split(/\s+/).filter(Boolean)
          : (overrides.scopes ?? server.auth.scopes),
      },
      updatedByUserId: overrides.actorUserId ?? server.updatedByUserId,
      updatedAt: now(),
    });
  }
}

async function requireOAuthServer(
  repository: Pick<ProjectMcpServerRepository, "get">,
  projectId: string,
  serverId: string,
): Promise<
  ProjectMcpServer & {
    auth: Extract<ProjectMcpServer["auth"], { type: "oauth" }>;
  }
> {
  const server = await repository.get(projectId, serverId);
  if (!server) throw new Error("MCP server not found");
  if (server.auth.type !== "oauth") throw new Error("MCP server is not configured for OAuth");
  return server as ProjectMcpServer & {
    auth: Extract<ProjectMcpServer["auth"], { type: "oauth" }>;
  };
}

export function hashProjectMcpOAuthState(state: string): string {
  return sha256(state);
}

export function createDrizzleProjectMcpOAuthAttemptStore(): ProjectMcpOAuthAttemptStore {
  return {
    async create(attempt) {
      const payload = encryptIntegrationSecret(
        JSON.stringify({
          ...attempt,
          expiresAt: attempt.expiresAt.toISOString(),
        }),
      );
      await db.insert(schema.projectMcpOauthAttempts).values({
        serverId: attempt.serverId,
        stateHash: attempt.stateHash,
        payloadCiphertext: payload.ciphertext,
        payloadNonce: payload.nonce,
        payloadKeyVersion: payload.keyVersion,
        expiresAt: attempt.expiresAt,
      });
    },
    async consume(state) {
      const [row] = await db
        .update(schema.projectMcpOauthAttempts)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(schema.projectMcpOauthAttempts.stateHash, hashProjectMcpOAuthState(state)),
            isNull(schema.projectMcpOauthAttempts.consumedAt),
          ),
        )
        .returning();
      if (!row) return null;
      const parsed = JSON.parse(
        decryptIntegrationSecret({
          ciphertext: row.payloadCiphertext,
          nonce: row.payloadNonce,
          keyVersion: row.payloadKeyVersion,
        }),
      ) as Omit<ProjectMcpOAuthAttempt, "expiresAt"> & { expiresAt: string };
      return { ...parsed, expiresAt: new Date(parsed.expiresAt) };
    },
  };
}

export function createFetchProjectMcpOAuthHttp(fetchOverride?: typeof fetch): ProjectMcpOAuthHttp {
  const fetchImpl = fetchOverride ?? strictProjectMcpFetch;
  return {
    discover: (serverUrl, signal) => discoverProjectMcpOAuth(fetchImpl, serverUrl, signal),
    async register(registrationEndpoint, redirectUri, scopes) {
      const response = await fetchImpl(registrationEndpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_name: "Superlog project agent",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
        }),
      });
      const body = await responseJson(response, "OAuth dynamic registration failed");
      if (typeof body.client_id !== "string")
        throw new Error("OAuth registration omitted client_id");
      return {
        clientId: body.client_id,
        clientSecret: typeof body.client_secret === "string" ? body.client_secret : null,
      };
    },
    async exchange(input) {
      return tokenRequest(
        fetchImpl,
        input.tokenEndpoint,
        {
          grant_type: "authorization_code",
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: input.redirectUri,
          client_id: input.clientId,
          resource: input.resource,
        },
        input.clientId,
        input.clientSecret,
      );
    },
    async refresh(input) {
      return tokenRequest(
        fetchImpl,
        input.tokenEndpoint,
        {
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
          client_id: input.clientId,
          resource: input.resource,
          ...(input.scopes.length > 0 ? { scope: input.scopes.join(" ") } : {}),
        },
        input.clientId,
        input.clientSecret,
      );
    },
    async clientCredentials(input) {
      return tokenRequest(
        fetchImpl,
        input.tokenEndpoint,
        {
          grant_type: "client_credentials",
          client_id: input.clientId,
          resource: input.resource,
          ...(input.scopes.length > 0 ? { scope: input.scopes.join(" ") } : {}),
        },
        input.clientId,
        input.clientSecret,
      );
    },
  };
}

async function discoverProjectMcpOAuth(
  fetchImpl: typeof fetch,
  serverUrl: string,
  signal?: AbortSignal,
): Promise<ProjectMcpOAuthDiscovery> {
  const endpoint = new URL(serverUrl);
  const initial = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    redirect: "manual",
    signal,
  });
  const challenge = initial.headers.get("www-authenticate") ?? "";
  const advertised = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
  const resourceCandidates = [
    advertised,
    new URL(`/.well-known/oauth-protected-resource${endpoint.pathname}`, endpoint).toString(),
    new URL("/.well-known/oauth-protected-resource", endpoint).toString(),
  ].filter((value, index, all): value is string => !!value && all.indexOf(value) === index);
  const resourceMetadata = await firstJson(fetchImpl, resourceCandidates, signal);
  const authorizationServers = readStringArray(resourceMetadata.authorization_servers);
  if (authorizationServers.length === 0) {
    throw new Error("MCP protected-resource metadata has no authorization server");
  }
  const authorizationServer = authorizationServers[0] as string;
  const metadata = await firstJson(
    fetchImpl,
    authorizationMetadataUrls(authorizationServer),
    signal,
  );
  const resourceScopes = readStringArray(resourceMetadata.scopes_supported);
  return {
    authorizationServer,
    authorizationEndpoint: requiredMetadataUrl(metadata.authorization_endpoint),
    tokenEndpoint: requiredMetadataUrl(metadata.token_endpoint),
    registrationEndpoint: optionalMetadataUrl(metadata.registration_endpoint),
    resource:
      typeof resourceMetadata.resource === "string"
        ? resourceMetadata.resource
        : endpoint.toString(),
    codeChallengeMethods: readStringArray(metadata.code_challenge_methods_supported),
    grantTypes: readStringArray(metadata.grant_types_supported),
    scopesSupported: resourceScopes,
  };
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  tokenEndpoint: string,
  values: Record<string, string>,
  clientId: string,
  clientSecret: string | null,
): Promise<ProjectMcpOAuthTokenResponse> {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (clientSecret) {
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    );
  }
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    redirect: "manual",
    headers,
    body: new URLSearchParams(values),
  });
  const body = await responseJson(response, "OAuth token request failed");
  if (typeof body.access_token !== "string")
    throw new Error("OAuth token response omitted access_token");
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : null,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

async function firstJson(
  fetchImpl: typeof fetch,
  urls: string[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal,
      });
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch {
      // Try the next standards-defined discovery location.
    }
  }
  throw new Error("OAuth metadata discovery failed");
}

async function responseJson(response: Response, message: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${message} (${response.status})`);
  return (await response.json()) as Record<string, unknown>;
}

function authorizationMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, url).toString(),
    new URL(`/.well-known/openid-configuration${path}`, url).toString(),
    new URL(`${path}/.well-known/openid-configuration`, url).toString(),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function requiredMetadataUrl(value: unknown): string {
  const url = optionalMetadataUrl(value);
  if (!url) throw new Error("OAuth metadata omitted a required endpoint");
  return url;
}

function optionalMetadataUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("OAuth endpoints must use HTTPS");
  return url.toString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
