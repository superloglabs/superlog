import { timingSafeEqual } from "node:crypto";
import type { Env, Hono } from "hono";
import { requestSentryInstallationToken } from "./authorization.js";

const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
];
const RESPONSE_HEADERS = ["cache-control", "content-type", "mcp-session-id", "retry-after"];

export type SentryMcpCredential = {
  id: string;
  sentryInstallationId: string;
  organizationSlug: string;
  projectSlug: string;
  accessToken: string;
  refreshToken: string | null;
  relayToken: string;
  expiresAt: Date | null;
};

export type SentryMcpCredentialRepository = {
  getActive(projectId: string): Promise<SentryMcpCredential | null>;
  refreshIfExpiring(
    installationId: string,
    refreshAt: Date,
    issueToken: (credential: SentryMcpCredential) => Promise<{
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
    }>,
  ): Promise<SentryMcpCredential>;
  markNeedsReauth(installationId: string, reason: string): Promise<void>;
};

type RelayDependencies = {
  repository: SentryMcpCredentialRepository;
  fetch: typeof fetch;
  now: () => Date;
  clientId: string | undefined;
  clientSecret: string | undefined;
};

export function mountSentryMcpRelayPublic<E extends Env>(
  app: Hono<E>,
  deps: RelayDependencies,
): void {
  app.on(["POST", "GET", "DELETE"], "/api/sentry-mcp-relay/:projectId", async (c) => {
    let credential = await deps.repository.getActive(c.req.param("projectId"));
    if (!credential) return c.json({ error: "relay target not found" }, 404);
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.toLowerCase().startsWith("bearer ")
      ? authorization.slice(7).trim()
      : "";
    if (!safeEqual(token, credential.relayToken)) {
      return c.json({ error: "invalid relay credential" }, 401);
    }

    if (credential.expiresAt && credential.expiresAt.getTime() <= deps.now().getTime() + 60_000) {
      if (!deps.clientId || !deps.clientSecret || !credential.refreshToken) {
        await deps.repository.markNeedsReauth(credential.id, "Sentry OAuth token expired");
        return c.json({ error: "Sentry reconnect required" }, 401);
      }
      try {
        credential = await refreshCredential(deps, credential);
      } catch (error) {
        await deps.repository.markNeedsReauth(
          credential.id,
          error instanceof Error ? error.message : String(error),
        );
        return c.json({ error: "Sentry reconnect required" }, 401);
      }
    }

    const upstreamUrl = new URL(
      `/mcp/${encodeURIComponent(credential.organizationSlug)}/${encodeURIComponent(credential.projectSlug)}`,
      "https://mcp.sentry.dev",
    );
    upstreamUrl.searchParams.set("skills", "inspect");
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    headers.set("authorization", `Sentry-Bearer ${credential.accessToken}`);
    const upstream = await deps.fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" ? undefined : await c.req.arrayBuffer(),
      redirect: "manual",
    });
    if (upstream.status === 401 || upstream.status === 403) {
      await deps.repository.markNeedsReauth(
        credential.id,
        `Sentry MCP rejected OAuth token (${upstream.status})`,
      );
    }
    const responseHeaders = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  });
}

async function refreshCredential(
  deps: RelayDependencies,
  credential: SentryMcpCredential,
): Promise<SentryMcpCredential> {
  return deps.repository.refreshIfExpiring(
    credential.id,
    new Date(deps.now().getTime() + 60_000),
    async (lockedCredential) => {
      const token = await requestSentryInstallationToken({
        installationId: lockedCredential.sentryInstallationId,
        clientId: deps.clientId ?? "",
        clientSecret: deps.clientSecret ?? "",
        grant: { type: "refresh_token", refreshToken: lockedCredential.refreshToken ?? "" },
        fetchImpl: deps.fetch,
      });
      return {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
      };
    },
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
