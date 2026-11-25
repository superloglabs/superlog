// Relays the web app's browser spans to the OTLP intake.
//
// The browser cannot hold an ingest key: anything shipped in the web bundle is
// public. Instead it posts its spans here with the user's session cookie, and
// the API forwards them with headers that only the server knows. Requests
// without a session are rejected by the session middleware in front of this
// route, and checked again here so the route is safe to mount on its own.

import type { Env, Hono } from "hono";
import { requestBodyLimit } from "./request-body-limits.js";

export const BROWSER_TELEMETRY_PATH = "/api/browser-telemetry/v1/traces";
export const BROWSER_TELEMETRY_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const ACCEPTED_CONTENT_TYPES = new Set(["application/json", "application/x-protobuf"]);

export type BrowserTelemetryRelayConfig = {
  tracesUrl: string;
  headers: Record<string, string>;
};

type RelayEnv = Partial<
  Record<
    | "BROWSER_TELEMETRY_OTLP_ENDPOINT"
    | "BROWSER_TELEMETRY_OTLP_HEADERS"
    | "OTEL_EXPORTER_OTLP_ENDPOINT"
    | "OTEL_EXPORTER_OTLP_HEADERS"
    | "OTEL_EXPORTER_OTLP_PROTOCOL"
    | "OTEL_SDK_DISABLED",
    string | undefined
  >
>;

function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}

function tracesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/traces`;
}

/**
 * The relay target. A dedicated BROWSER_TELEMETRY_OTLP_* pair wins; otherwise
 * the relay reuses the API's own OTLP/HTTP exporter settings, unless the API's
 * own telemetry is switched off (tracing.ts sets OTEL_SDK_DISABLED outside
 * production). The API's exporter headers are only ever sent to the API's
 * exporter endpoint.
 */
export function browserTelemetryRelayConfigFromEnv(
  env: RelayEnv,
): BrowserTelemetryRelayConfig | null {
  const dedicated = env.BROWSER_TELEMETRY_OTLP_ENDPOINT?.trim();
  if (dedicated) {
    return {
      tracesUrl: tracesUrl(dedicated),
      headers: parseOtlpHeaders(env.BROWSER_TELEMETRY_OTLP_HEADERS),
    };
  }
  const exporter = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const protocol = env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim().toLowerCase();
  if (!exporter || protocol === "grpc") return null;
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return null;
  return {
    tracesUrl: tracesUrl(exporter),
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
  };
}

export type BrowserTelemetryRelayDeps = {
  config: BrowserTelemetryRelayConfig | null;
  fetch?: typeof fetch;
};

export function mountBrowserTelemetryRelay<E extends Env>(
  app: Hono<E>,
  deps: BrowserTelemetryRelayDeps,
): void {
  const fetchImpl = deps.fetch ?? fetch;

  app.post(BROWSER_TELEMETRY_PATH, requestBodyLimit(BROWSER_TELEMETRY_BODY_BYTES), async (c) => {
    const userId = (c.var as { userId?: string }).userId;
    if (!userId) return c.json({ error: "unauthenticated" }, 401);

    const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (!contentType || !ACCEPTED_CONTENT_TYPES.has(contentType)) {
      return c.json({ error: "unsupported content type" }, 415);
    }

    const body = await c.req.arrayBuffer();
    if (!deps.config) return c.body(null, 204);

    try {
      const upstream = await fetchImpl(deps.config.tracesUrl, {
        method: "POST",
        headers: { ...deps.config.headers, "content-type": contentType },
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      await upstream.body?.cancel();
      return c.body(null, upstream.status as 200);
    } catch {
      return c.json({ error: "telemetry upstream unavailable" }, 502);
    }
  });
}
