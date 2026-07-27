import type { Server } from "node:http";

const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 75_000;

type HttpServerTimeoutEnvironment = {
  HTTP_KEEP_ALIVE_TIMEOUT_MS?: string;
};

export function configureHttpServerTimeouts(
  server: Pick<Server, "headersTimeout" | "keepAliveTimeout">,
  env: HttpServerTimeoutEnvironment = process.env,
): void {
  const keepAliveTimeoutMs = Number(
    env.HTTP_KEEP_ALIVE_TIMEOUT_MS ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  );
  server.keepAliveTimeout = keepAliveTimeoutMs;

  if (keepAliveTimeoutMs > 0) {
    server.headersTimeout = keepAliveTimeoutMs + 1_000;
  }
}
