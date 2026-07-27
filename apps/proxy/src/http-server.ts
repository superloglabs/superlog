import type { Server } from "node:http";

const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 75_000;

type HttpServerTimeoutEnvironment = {
  HTTP_KEEP_ALIVE_TIMEOUT_MS?: string;
};

function keepAliveTimeoutMs(env: HttpServerTimeoutEnvironment): number {
  const raw = env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_KEEP_ALIVE_TIMEOUT_MS;

  const value = Number(raw);
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error("HTTP_KEEP_ALIVE_TIMEOUT_MS must be a nonnegative integer");
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
    server.headersTimeout = timeoutMs + 1_000;
  }
}
