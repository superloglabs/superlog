import { type KeyObject, createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { hasMcpWriteAccess } from "./scope-authorization.js";

// When a project's customer moves to a workspace of the Superlog application,
// their MCP clients keep this address and their tokens. Once the project is
// cut over, its requests go to the application's MCP endpoint for the
// workspace with the project's ID. Each forwarded request carries a
// short-lived assertion signed with this product's Ed25519 key,
// LEGACY_MCP_FORWARD_SIGNING_KEY. It names the project, the token owner's
// email, the token's access, the workspace origin, and a hash of the request
// body, so it is good for that one request at that one address. The
// application holds only the public key, decides which projects it accepts,
// and acts as the workspace member with that email. This is removed when this
// product shuts down.

const log = logger.child({ scope: "mcp-forwarding" });

export const MCP_FORWARD_ASSERTION_HEADER = "x-legacy-mcp-assertion";
const ASSERTION_ISSUER = "superlog-legacy-mcp";
const ASSERTION_LIFETIME_SECONDS = 60;

export type McpForwardAccess = "read" | "read-write";

// A token without the full read/write grant, or limited to telemetry, may use
// only the application's read-only tools.
export function mcpForwardAccess(scope: string | null, telemetryOnly: boolean): McpForwardAccess {
  const scopes = scope?.split(/\s+/).filter(Boolean) ?? [];
  return hasMcpWriteAccess(scopes) && !telemetryOnly ? "read-write" : "read";
}

// The signing key: a base64 PKCS#8 DER Ed25519 private key. Null when unset or
// unusable.
export function parseForwardSigningKey(value: string | undefined): KeyObject | null {
  const text = value?.trim();
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    const key = createPrivateKey({
      format: "der",
      key: Buffer.from(text, "base64"),
      type: "pkcs8",
    });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

// A compact JWS (EdDSA) for one request: the workspace origin as audience,
// the project, email and access, and the SHA-256 of the body.
export function signForwardAssertion(
  forward: Omit<McpForward, "endpoint"> & { audience: string },
  body: Uint8Array,
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      access: forward.access,
      aud: forward.audience,
      body: createHash("sha256").update(body).digest("base64url"),
      email: forward.email,
      exp: iat + ASSERTION_LIFETIME_SECONDS,
      iat,
      iss: ASSERTION_ISSUER,
      jti: randomBytes(16).toString("base64url"),
      project: forward.projectId,
    }),
  );
  const signature = sign(null, Buffer.from(`${header}.${claims}`), forward.signingKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

// The application's MCP endpoint at a workspace origin. Only HTTPS origins,
// or plain HTTP on localhost for local development, receive an assertion.
export function workspaceMcpEndpoint(workspaceUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(workspaceUrl);
  } catch {
    return null;
  }
  const local =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !local) || url.username || url.password) return null;
  return new URL("/api/mcp", url.origin);
}

export type McpForward = {
  access: McpForwardAccess;
  email: string;
  endpoint: URL;
  projectId: string;
  signingKey: KeyObject;
};

const FORWARD_HEADERS_TIMEOUT_MS = 120_000;
// Streamable HTTP headers pass both ways. The client's Authorization header
// holds this product's token and stays here.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
];
const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "mcp-session-id",
  "retry-after",
];

export class McpForwardRedirectError extends Error {
  constructor(readonly status: number) {
    super(`workspace MCP endpoint answered with redirect ${status}`);
    this.name = "McpForwardRedirectError";
  }
}

// Sends the client's JSON-RPC request on unchanged and streams the answer back.
// A redirect is never followed, since it would carry the assertion and the
// email to another address.
export async function forwardMcpRequest(
  request: Request,
  forward: McpForward,
  send: typeof fetch = fetch,
  timeoutMs = FORWARD_HEADERS_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = new Uint8Array(hasBody ? await request.arrayBuffer() : new ArrayBuffer(0));
  headers.set(
    MCP_FORWARD_ASSERTION_HEADER,
    signForwardAssertion({ ...forward, audience: forward.endpoint.origin }, body),
  );
  // The timeout covers waiting for the response headers only. A stream, such
  // as a GET event stream, stays open for as long as the workspace keeps it.
  const headersTimeout = new AbortController();
  const timer = setTimeout(
    () => headersTimeout.abort(new Error("workspace MCP endpoint did not answer in time")),
    timeoutMs,
  );
  let upstream: Response;
  try {
    upstream = await send(forward.endpoint, {
      body: hasBody ? body : undefined,
      headers,
      method: request.method,
      redirect: "manual",
      signal: headersTimeout.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
    await upstream.body?.cancel().catch(() => {});
    throw new McpForwardRedirectError(upstream.status);
  }
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { headers: responseHeaders, status: upstream.status });
}

function forwardError(status: 502 | 503, message: string): Response {
  return new Response(JSON.stringify({ error: "forwarding_failed", error_description: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Forwards a request authenticated for a cut-over project. A missing signing
// key or an invalid workspace address is a configuration error, so the
// request fails instead of being served here.
export async function forwardToWorkspace(
  request: Request,
  token: {
    projectId: string;
    scope: string | null;
    telemetryOnly?: boolean;
    tokenId: string;
    userId: string;
  },
  workspaceUrl: string,
  send: typeof fetch = fetch,
): Promise<Response> {
  const signingKey = parseForwardSigningKey(process.env.LEGACY_MCP_FORWARD_SIGNING_KEY);
  const endpoint = workspaceMcpEndpoint(workspaceUrl);
  if (!signingKey || !endpoint) {
    log.error(
      { projectId: token.projectId, signingKey: Boolean(signingKey), endpoint: Boolean(endpoint) },
      "mcp forwarding is not configured",
    );
    return forwardError(503, "This project has moved, and forwarding is not configured.");
  }
  const user = await db.query.users.findFirst({
    columns: { email: true },
    where: eq(schema.users.id, token.userId),
  });
  if (!user) return forwardError(503, "The token's user was not found.");
  try {
    const response = await forwardMcpRequest(
      request,
      {
        access: mcpForwardAccess(token.scope, token.telemetryOnly ?? false),
        email: user.email,
        endpoint,
        projectId: token.projectId,
        signingKey,
      },
      send,
    );
    log.info(
      { projectId: token.projectId, tokenId: token.tokenId, status: response.status },
      "mcp forwarded",
    );
    return response;
  } catch (error) {
    log.error(
      { projectId: token.projectId, tokenId: token.tokenId, err: error },
      "mcp forwarding failed",
    );
    return forwardError(502, "The project's workspace is unavailable.");
  }
}
