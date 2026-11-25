import { type GuardedPublicFetchInit, guardedPublicFetch } from "@superlog/net-guard";

type GuardedEgress = (url: string | URL, init?: GuardedPublicFetchInit) => Promise<Response>;

// Replies are read with the egress size limit, because the MCP SDK and the
// OAuth flow buffer them. `streaming` lifts the limit for the relay, which
// passes the upstream body to its client with backpressure and never buffers
// it, and whose server-sent event streams can stay open for a long time.
export function createProjectMcpFetch(
  egress: GuardedEgress = guardedPublicFetch,
  options: { streaming?: boolean } = {},
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    if (input instanceof Request) {
      throw new Error("project MCP fetch requires an explicit destination URL");
    }
    const url = new URL(input.toString());
    assertProjectMcpHttpsUrl(url);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    return egress(url, {
      method: init.method,
      headers,
      body: normalizeBody(init.body),
      signal: init.signal ?? undefined,
      ...(options.streaming ? { maxResponseBytes: Number.POSITIVE_INFINITY } : {}),
    });
  }) as typeof fetch;
}

export const strictProjectMcpFetch = createProjectMcpFetch();
export const streamingProjectMcpFetch = createProjectMcpFetch(guardedPublicFetch, {
  streaming: true,
});

function assertProjectMcpHttpsUrl(url: URL): void {
  if (url.protocol !== "https:") throw new Error("MCP destination must use HTTPS");
  if (url.username || url.password) throw new Error("MCP destination must not contain credentials");
}

function normalizeBody(body: RequestInit["body"]): GuardedPublicFetchInit["body"] {
  if (body === undefined || body === null || typeof body === "string") return body ?? undefined;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("unsupported project MCP request body");
}
