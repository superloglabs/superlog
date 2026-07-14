import "./project-mcp-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectMcpServer, ProjectMcpServerRepository } from "@superlog/db";
import { type ProjectMcpOAuthAttempt, createProjectMcpOAuthService } from "./project-mcp-oauth.js";

function oauthServer(): ProjectMcpServer {
  const now = new Date("2026-07-14T10:00:00.000Z");
  return {
    id: "server-1",
    projectId: "project-1",
    name: "linear",
    url: "https://linear.example/mcp",
    enabled: false,
    auth: {
      type: "oauth",
      grantType: "authorization_code",
      status: "pending",
      scopes: ["issues:read"],
      clientId: null,
      clientSecret: null,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      tokenEndpoint: null,
      authorizationServer: null,
      resource: null,
    },
    trustedAt: now,
    trustedByUserId: "user-1",
    createdByUserId: "user-1",
    updatedByUserId: "user-1",
    createdAt: now,
    updatedAt: now,
  };
}

test("OAuth start uses discovery, dynamic registration, PKCE, and resource binding", async () => {
  let server = oauthServer();
  let attempt: ProjectMcpOAuthAttempt | null = null;
  const repository = {
    get: async () => server,
    update: async (next: ProjectMcpServer) => {
      server = next;
      return next;
    },
  } as unknown as ProjectMcpServerRepository;
  const service = createProjectMcpOAuthService({
    repository,
    attempts: {
      create: async (value) => {
        attempt = value;
      },
      consume: async () => null,
    },
    http: {
      discover: async () => ({
        authorizationServer: "https://auth.example",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        registrationEndpoint: "https://auth.example/register",
        resource: "https://linear.example/mcp",
        codeChallengeMethods: ["S256"],
        grantTypes: ["authorization_code", "refresh_token"],
      }),
      register: async () => ({
        clientId: "dynamic-client",
        clientSecret: null,
      }),
      exchange: async () => {
        throw new Error("not called");
      },
      refresh: async () => {
        throw new Error("not called");
      },
      clientCredentials: async () => {
        throw new Error("not called");
      },
    },
    randomToken: (() => {
      const values = ["state-value", "verifier-value"];
      return () => values.shift() ?? "unused";
    })(),
    now: () => new Date("2026-07-14T10:00:00.000Z"),
  });

  const result = await service.start({
    projectId: "project-1",
    serverId: "server-1",
    actorUserId: "user-1",
    redirectUri: "https://api.superlog.sh/api/agent-mcp-oauth/callback",
  });

  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get("client_id"), "dynamic-client");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://linear.example/mcp");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(attempt);
  assert.equal((attempt as ProjectMcpOAuthAttempt).clientSecret, null);
  assert.equal(JSON.stringify(result).includes("verifier-value"), false);
});

test("OAuth completion consumes the PKCE attempt and stores the token without exposing it", async () => {
  let server = oauthServer();
  const repository = {
    get: async () => server,
    update: async (next: ProjectMcpServer) => {
      server = next;
      return next;
    },
  } as unknown as ProjectMcpServerRepository;
  const service = createProjectMcpOAuthService({
    repository,
    attempts: {
      create: async () => {},
      consume: async () => ({
        projectId: server.projectId,
        serverId: server.id,
        stateHash: "hash",
        codeVerifier: "verifier",
        redirectUri: "https://api.superlog.sh/api/agent-mcp-oauth/callback",
        clientId: "client",
        clientSecret: null,
        tokenEndpoint: "https://auth.example/token",
        authorizationServer: "https://auth.example",
        resource: server.url,
        scopes: ["issues:read"],
        expiresAt: new Date("2026-07-14T10:10:00.000Z"),
      }),
    },
    http: {
      discover: async () => {
        throw new Error("not called");
      },
      register: async () => {
        throw new Error("not called");
      },
      exchange: async (input) => {
        assert.equal(input.codeVerifier, "verifier");
        assert.equal(input.resource, server.url);
        return {
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresInSeconds: 3600,
          scope: "issues:read issues:write",
        };
      },
      refresh: async () => {
        throw new Error("not called");
      },
      clientCredentials: async () => {
        throw new Error("not called");
      },
    },
    now: () => new Date("2026-07-14T10:00:00.000Z"),
  });

  const result = await service.complete({ state: "state", code: "code" });

  assert.equal(result.auth.type, "oauth");
  if (result.auth.type !== "oauth") return;
  assert.equal(result.auth.status, "connected");
  assert.equal(result.auth.accessToken, "access-secret");
  assert.deepEqual(result.auth.scopes, ["issues:read", "issues:write"]);
});

test("expired OAuth access tokens are refreshed and rotated refresh tokens are retained", async () => {
  let server = oauthServer();
  if (server.auth.type !== "oauth") throw new Error("bad fixture");
  server = {
    ...server,
    auth: {
      ...server.auth,
      status: "connected",
      clientId: "client",
      clientSecret: "client-secret",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date("2026-07-14T10:00:30.000Z"),
      tokenEndpoint: "https://auth.example/token",
      resource: server.url,
    },
  };
  const repository = {
    get: async () => server,
    update: async (next: ProjectMcpServer) => {
      server = next;
      return next;
    },
  } as unknown as ProjectMcpServerRepository;
  const service = createProjectMcpOAuthService({
    repository,
    attempts: { create: async () => {}, consume: async () => null },
    http: {
      discover: async () => {
        throw new Error("not called");
      },
      register: async () => {
        throw new Error("not called");
      },
      exchange: async () => {
        throw new Error("not called");
      },
      refresh: async (input) => {
        assert.equal(input.refreshToken, "old-refresh");
        return {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresInSeconds: 1800,
          scope: null,
        };
      },
      clientCredentials: async () => {
        throw new Error("not called");
      },
    },
    now: () => new Date("2026-07-14T10:00:00.000Z"),
  });

  const result = await service.ensureFresh({
    projectId: server.projectId,
    serverId: server.id,
  });

  assert.equal(result.auth.type, "oauth");
  if (result.auth.type !== "oauth") return;
  assert.equal(result.auth.accessToken, "new-access");
  assert.equal(result.auth.refreshToken, "new-refresh");
});

test("OAuth client credentials is accepted only when the authorization server advertises it", async () => {
  let server = oauthServer();
  if (server.auth.type !== "oauth") throw new Error("bad fixture");
  server = {
    ...server,
    auth: {
      ...server.auth,
      grantType: "client_credentials",
      clientId: "service-client",
      clientSecret: "service-secret",
    },
  };
  const repository = {
    get: async () => server,
    update: async (next: ProjectMcpServer) => {
      server = next;
      return next;
    },
  } as unknown as ProjectMcpServerRepository;
  const service = createProjectMcpOAuthService({
    repository,
    attempts: { create: async () => {}, consume: async () => null },
    http: {
      discover: async () => ({
        authorizationServer: "https://auth.example",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        registrationEndpoint: null,
        resource: server.url,
        codeChallengeMethods: ["S256"],
        grantTypes: ["client_credentials"],
      }),
      register: async () => {
        throw new Error("not called");
      },
      exchange: async () => {
        throw new Error("not called");
      },
      refresh: async () => {
        throw new Error("not called");
      },
      clientCredentials: async (input) => {
        assert.equal(input.clientId, "service-client");
        assert.equal(input.resource, server.url);
        return {
          accessToken: "service-access",
          refreshToken: null,
          expiresInSeconds: 600,
          scope: null,
        };
      },
    },
    now: () => new Date("2026-07-14T10:00:00.000Z"),
  });

  const result = await service.connectClientCredentials({
    projectId: server.projectId,
    serverId: server.id,
    actorUserId: "user-1",
  });

  assert.equal(result.auth.type, "oauth");
  if (result.auth.type !== "oauth") return;
  assert.equal(result.auth.status, "connected");
  assert.equal(result.auth.accessToken, "service-access");
});
