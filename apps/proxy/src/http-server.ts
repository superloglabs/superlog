import type { Server } from "node:http";

const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 75_000;
const DEFAULT_SERVER_BACKLOG = 4096;
const HEADERS_TIMEOUT_MARGIN_MS = 1_000;
const MAX_KEEP_ALIVE_TIMEOUT_MS = 2_147_483_647 - HEADERS_TIMEOUT_MARGIN_MS;

type HttpServerTimeoutEnvironment = {
  HTTP_KEEP_ALIVE_TIMEOUT_MS?: string;
};

type HttpServerBacklogEnvironment = {
  HTTP_SERVER_BACKLOG?: string;
};

export function serverBacklog(env: HttpServerBacklogEnvironment = process.env): number {
  const raw = env.HTTP_SERVER_BACKLOG;
  if (raw === undefined) return DEFAULT_SERVER_BACKLOG;

  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error("HTTP_SERVER_BACKLOG must be a positive integer");
  }
  return value;
}

function keepAliveTimeoutMs(env: HttpServerTimeoutEnvironment): number {
  const raw = env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_KEEP_ALIVE_TIMEOUT_MS;

  const value = Number(raw);
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error("HTTP_KEEP_ALIVE_TIMEOUT_MS must be a nonnegative integer");
  }
  if (value > MAX_KEEP_ALIVE_TIMEOUT_MS) {
    throw new Error(`HTTP_KEEP_ALIVE_TIMEOUT_MS must not exceed ${MAX_KEEP_ALIVE_TIMEOUT_MS}`);
  }
  return value;
}

export function configureHttpServerTimeouts(
  server: Pick<Server, "headersTimeout" | "keepAliveTimeout">,
  env: HttpServerTimeoutEnvironment = process.env,
): void {
  const timeoutMs = keepAliveTimeoutMs(env);
  server.keepAliveTimeout = timeoutMs;

  if (timeoutMs > 0) {
    server.headersTimeout = timeoutMs + HEADERS_TIMEOUT_MARGIN_MS;
  }
}
