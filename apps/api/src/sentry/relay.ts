import { timingSafeEqual } from "node:crypto";
import type { Env, Hono } from "hono";

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
  organizationSlug: string;
  projectSlug: string;
  accessToken: string;
  refreshToken: string | null;
  relayToken: string;
  expiresAt: Date | null;
};

export type SentryMcpCredentialRepository = {
  getActive(projectId: string): Promise<SentryMcpCredential | null>;
  updateToken(
    installationId: string,
    token: { accessToken: string; refreshToken: string | null; expiresAt: Date | null },
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
  const response = await deps.fetch("https://sentry.io/oauth/token/", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.clientId ?? "",
      client_secret: deps.clientSecret ?? "",
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken ?? "",
    }),
    redirect: "error",
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new Error(`Sentry OAuth refresh failed (${response.status})`);
  }
  return deps.repository.updateToken(credential.id, {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === "string" ? payload.refresh_token : credential.refreshToken,
    expiresAt:
      typeof payload.expires_at === "string"
        ? validDate(payload.expires_at)
        : typeof payload.expires_in === "number"
          ? new Date(deps.now().getTime() + payload.expires_in * 1000)
          : null,
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
