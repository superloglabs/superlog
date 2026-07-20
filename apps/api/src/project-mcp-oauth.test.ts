import "./project-mcp-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectMcpServer, ProjectMcpServerRepository } from "@superlog/db";
import {
  type ProjectMcpOAuthAttempt,
  createFetchProjectMcpOAuthHttp,
  createProjectMcpOAuthService,
} from "./project-mcp-oauth.js";

function oauthServer(): ProjectMcpServer {
  const now = new Date("2026-07-14T10:00:00.000Z");
  return {
    id: "server-1",
    projectId: "project-1",
    name: "linear",
    displayName: "Linear",
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

test("OAuth discovery rejects private destinations at the outbound request boundary", async () => {
  await assert.rejects(
    createFetchProjectMcpOAuthHttp().discover("https://127.0.0.1/mcp"),
    /not allowed/i,
  );
});

test("OAuth dynamic registration restricts the client to requested scopes", async () => {
  const registrationBodies: Record<string, unknown>[] = [];
  const fakeFetch = (async (_input: URL | string | Request, init?: RequestInit) => {
    registrationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ client_id: "dynamic-client" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await createFetchProjectMcpOAuthHttp(fakeFetch).register(
    "https://auth.example/register",
    "https://api.superlog.sh/api/agent-mcp-oauth/callback",
    ["projects:read", "database:read"],
  );

  assert.equal(registrationBodies[0]?.scope, "projects:read database:read");
});

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
        scopesSupported: ["issues:read", "issues:write"],
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
  // Operator-configured scopes take precedence over the server's advertised set.
  assert.equal(url.searchParams.get("scope"), "issues:read");
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
        serverUrl: server.url,
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

test("OAuth completion rejects a grant started before the server configuration changed", async () => {
  let server = oauthServer();
  const originalUrl = server.url;
  let exchangeCalled = false;
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
        serverUrl: originalUrl,
        stateHash: "hash",
        codeVerifier: "verifier",
        redirectUri: "https://api.superlog.sh/api/agent-mcp-oauth/callback",
        clientId: "client",
        clientSecret: null,
        tokenEndpoint: "https://auth.example/token",
        authorizationServer: "https://auth.example",
        resource: originalUrl,
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
      exchange: async () => {
        exchangeCalled = true;
        throw new Error("must not exchange");
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

  server = { ...server, url: "https://replacement.example/mcp" };

  await assert.rejects(
    service.complete({ state: "state", code: "code" }),
    /configuration changed/i,
  );
  assert.equal(exchangeCalled, false);
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
      scopes: [],
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
        scopesSupported: ["service:read"],
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
        assert.deepEqual(input.scopes, ["service:read"]);
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
  assert.deepEqual(result.auth.scopes, ["service:read"]);
});

test("OAuth start requests the server's advertised scopes when none are configured", async () => {
  let server = oauthServer();
  server = {
    ...server,
    auth: { ...server.auth, type: "oauth", scopes: [] } as ProjectMcpServer["auth"],
  };
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
        scopesSupported: ["projects:read", "database:read"],
      }),
      register: async (_registrationEndpoint, _redirectUri, scopes) => {
        assert.deepEqual(scopes, ["projects:read", "database:read"]);
        return { clientId: "dynamic-client", clientSecret: null };
      },
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
  assert.equal(url.searchParams.get("scope"), "projects:read database:read");
  // The advertised set is persisted so a token response without `scope` still
  // records what was actually requested.
  assert.deepEqual((attempt as unknown as ProjectMcpOAuthAttempt).scopes, [
    "projects:read",
    "database:read",
  ]);
});

test("OAuth discovery prefers the protected-resource scopes_supported over the auth server's", async () => {
  const json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });
  const fakeFetch = (async (input: URL | string | Request) => {
    const target = input.toString();
    if (target === "https://mcp.example/mcp") {
      return new Response(null, { status: 401 });
    }
    if (target === "https://mcp.example/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: "https://mcp.example/mcp?read_only=true",
        authorization_servers: ["https://as.example"],
        scopes_supported: ["projects:read", "database:read"],
      });
    }
    if (target === "https://as.example/.well-known/oauth-authorization-server") {
      return json({
        authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code"],
        // The auth server advertises writes too; discovery must not pick these
        // up when the protected resource has already narrowed the set.
        scopes_supported: ["projects:read", "projects:write", "database:write"],
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  const discovery =
    await createFetchProjectMcpOAuthHttp(fakeFetch).discover("https://mcp.example/mcp");

  assert.deepEqual(discovery.scopesSupported, ["projects:read", "database:read"]);
});

test("OAuth discovery does not default to authorization-server scopes", async () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fakeFetch = (async (input: URL | string | Request) => {
    const target = input.toString();
    if (target === "https://mcp.example/mcp") {
      return new Response(null, { status: 401 });
    }
    if (target === "https://mcp.example/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://as.example"],
      });
    }
    if (target === "https://as.example/.well-known/oauth-authorization-server") {
      return json({
        authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code"],
        scopes_supported: ["projects:read", "projects:write", "admin"],
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  const discovery =
    await createFetchProjectMcpOAuthHttp(fakeFetch).discover("https://mcp.example/mcp");

  assert.deepEqual(discovery.scopesSupported, []);
});

test("OAuth discovery honors an explicitly empty protected-resource scope list", async () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fakeFetch = (async (input: URL | string | Request) => {
    const target = input.toString();
    if (target === "https://mcp.example/mcp") {
      return new Response(null, { status: 401 });
    }
    if (target === "https://mcp.example/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://as.example"],
        scopes_supported: [],
      });
    }
    if (target === "https://as.example/.well-known/oauth-authorization-server") {
      return json({
        authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code"],
        scopes_supported: ["projects:read", "projects:write"],
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  const discovery =
    await createFetchProjectMcpOAuthHttp(fakeFetch).discover("https://mcp.example/mcp");

  assert.deepEqual(discovery.scopesSupported, []);
});
