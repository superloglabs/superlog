import "./env.js";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { hashApiKey, schema, syncLoopsContactsForProject } from "@superlog/db";
import { db } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { EmptyBodyError, PayloadTooLargeError } from "./body-capture.js";
import { stampIssueFingerprintsFailOpen } from "./ingest-fingerprints.js";
import { IngestQueue, getIngestQueueConfig } from "./ingest-queue.js";
import { logger } from "./logger.js";
import { proxyOperationalRecorder } from "./operational-metrics.js";
import { Semaphore } from "./semaphore.js";
import { lookupOrgForProject, recordIngestRequest } from "./tenant-metrics.js";

const tracer = trace.getTracer("@superlog/proxy");

type Variables = { projectId: string };

const app = new Hono<{ Variables: Variables }>();

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://localhost:4318";
const PORT = Number(process.env.PORT ?? 4000);
const ingestQueueConfig = getIngestQueueConfig(process.env);
const ingestQueue = ingestQueueConfig ? new IngestQueue(ingestQueueConfig, logger) : null;

// Bound how many ingest requests buffer/stream their bodies at once. Together
// with the per-request body cap (INGEST_MAX_BODY_BYTES) and S3 streaming for
// large bodies, this makes the proxy's memory a provable constant — roughly
// `permits × max_bytes_held_per_request` — so a burst can never OOM-kill the
// task (exit 137, the 2026-05-31 incident). Excess requests WAIT for a permit
// (backpressure) rather than being rejected; the body is only read once a permit
// is held, so waiters cost ~nothing. Default 64; tune via
// INGEST_MAX_INFLIGHT_REQUESTS, or set to 0 to disable.
const DEFAULT_MAX_INFLIGHT_REQUESTS = 64;
const MAX_INFLIGHT_REQUESTS = readNonNegativeIntEnv(
  process.env.INGEST_MAX_INFLIGHT_REQUESTS,
  DEFAULT_MAX_INFLIGHT_REQUESTS,
);
const requestSemaphore = new Semaphore(MAX_INFLIGHT_REQUESTS);

// Hard per-request body ceiling for the no-queue (direct) path. The queue path
// enforces its own copy via IngestQueueConfig.maxBodyBytes; both read the same
// env so they stay in lockstep. Bodies above this get a 413 (a permanent 4xx —
// OTLP exporters drop rather than retry), which is the explicit "too big to
// accept" decision. 64 MiB sits above the largest legitimate payload (~38 MiB).
const MAX_BODY_BYTES = readNonNegativeIntEnv(process.env.INGEST_MAX_BODY_BYTES, 64 * 1024 * 1024);

app.use(
  "/v1/*",
  cors({
    origin: "*",
    allowHeaders: ["authorization", "content-type", "x-api-key", "traceparent", "tracestate"],
    allowMethods: ["POST", "OPTIONS"],
  }),
);

app.use("/v1/*", async (c, next) => {
  return tracer.startActiveSpan("auth.validate", async (span) => {
    try {
      const key = extractApiKey(c);
      if (!key) {
        span.setAttribute("auth.result", "missing_key");
        span.setStatus({ code: SpanStatusCode.ERROR, message: "missing api key" });
        return c.json({ error: "missing api key" }, 401);
      }

      if (key === "SUPERLOG_TEST" || key.startsWith("superlog_test_")) {
        span.setAttribute("auth.result", "test_key");
        const path = new URL(c.req.url).pathname;
        if (path === "/v1/traces" || path === "/v1/logs" || path === "/v1/metrics") {
          logger.info({ path }, "test key short-circuit");
          return new Response(new Uint8Array(0), {
            status: 200,
            headers: { "content-type": "application/x-protobuf" },
          });
        }
        return c.json({ error: "test key only valid on /v1/{traces,logs,metrics}" }, 401);
      }

      if (key.startsWith("superlog_cli_")) {
        span.setAttribute("auth.result", "wrong_credential_type");
        span.setStatus({ code: SpanStatusCode.ERROR, message: "wrong credential type" });
        return c.json(
          {
            error:
              "wrong credential type: this endpoint requires an ingest API key (sl_public_* or legacy superlog_live_*); superlog_cli_* tokens are for the gateway at api.superlog.sh",
          },
          401,
        );
      }

      const row = await db.query.apiKeys.findFirst({
        where: eq(schema.apiKeys.keyHash, hashApiKey(key)),
      });
      if (!row || row.revokedAt) {
        span.setAttribute("auth.result", "invalid_key");
        span.setStatus({ code: SpanStatusCode.ERROR, message: "invalid api key" });
        return c.json({ error: "invalid api key" }, 401);
      }

      span.setAttribute("auth.result", "ok");
      span.setAttribute("tenant.project_id", row.projectId);
      c.set("projectId", row.projectId);
      const isFirstUse = row.lastUsedAt === null;
      void db
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.apiKeys.id, row.id))
        .then(() => {
          // Loops only needs the lifecycle nudge when telemetrySet flips false→true, i.e. on the
          // first ingest for this key. Firing on every request hammers the Loops rate limit.
          if (isFirstUse) return syncLoopsContactsForProject({ projectId: row.projectId });
        })
        .catch((err: unknown) => {
          logger.error({ err }, "failed to update last_used_at or sync loops contact");
        });

      await next();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
});

app.post("/v1/traces", (c) => forward(c, "/v1/traces", "resourceSpans"));
app.post("/v1/logs", (c) => forward(c, "/v1/logs", "resourceLogs"));
app.post("/v1/metrics", (c) => forward(c, "/v1/metrics", "resourceMetrics"));

app.get("/health", (c) => c.json({ ok: true }));

function readNonNegativeIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The request body as a byte stream, or null when there is no body to read. */
function requestBodyStream(c: Context<{ Variables: Variables }>): AsyncIterable<Uint8Array> | null {
  const body = c.req.raw.body;
  if (!body) return null;
  return Readable.fromWeb(
    body as Parameters<typeof Readable.fromWeb>[0],
  ) as unknown as AsyncIterable<Uint8Array>;
}

/** Buffer a stream fully, aborting at `maxBytes` (413) and on empty (400). */
async function collectStreamWithCap(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of source) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (chunk.length === 0) continue;
    total += chunk.length;
    if (total > maxBytes) throw new PayloadTooLargeError(maxBytes, total);
    chunks.push(chunk);
  }
  if (total === 0) throw new EmptyBodyError();
  return Buffer.concat(chunks, total);
}

/**
 * Map a body-capture failure to a permanent (non-retryable) 4xx response:
 * too-big → 413, empty → 400. Returns null for any other error so the caller
 * rethrows it (those become 5xx and OTLP exporters retry). 413/400 are 4xx, so
 * exporters drop the batch — correct, since neither will ever succeed on retry.
 */
function handleIngestBodyError(
  err: unknown,
  c: Context<{ Variables: Variables }>,
  span: Span,
  path: string,
  projectId: string,
): { status: number; response: Response } | null {
  if (err instanceof PayloadTooLargeError) {
    span.setAttribute("ingest.too_large", true);
    span.setAttribute("ingest.limit_bytes", err.limitBytes);
    logger.warn(
      { path, projectId, limitBytes: err.limitBytes, observedBytes: err.observedBytes },
      "rejecting oversize OTLP body",
    );
    return {
      status: 413,
      response: c.json({ error: `request body exceeds the ${err.limitBytes}-byte limit` }, 413),
    };
  }
  if (err instanceof EmptyBodyError) {
    span.setAttribute("ingest.empty_body", true);
    logger.warn({ path, projectId }, "dropping empty OTLP request body");
    return {
      status: 400,
      response: c.json({ error: "empty OTLP request body; no records to ingest" }, 400),
    };
  }
  return null;
}

function extractApiKey(c: Context): string | null {
  const header = c.req.header("x-api-key");
  if (header) return header;
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

async function forward(c: Context<{ Variables: Variables }>, path: string, rootKey: string) {
  return tracer.startActiveSpan("ingest.forward", async (span) => {
    const startedAt = performance.now();
    const projectId = c.var.projectId;
    const contentType = c.req.header("content-type") ?? "application/x-protobuf";
    const contentEncoding = c.req.header("content-encoding");
    let responseStatus = 500;
    let requestBytes = 0;
    let storage: "direct" | "inline" | "s3" = "direct";

    span.setAttribute("otlp.path", path);
    span.setAttribute("otlp.root_key", rootKey);
    span.setAttribute("tenant.project_id", projectId);
    span.setAttribute("http.request.content_type", contentType);
    if (contentEncoding) span.setAttribute("http.request.content_encoding", contentEncoding);

    // Wait for a concurrency permit before touching the body. Excess requests
    // queue here cheaply (just a pending promise + their socket) instead of being
    // rejected — backpressure, not shedding. The body is only read once a permit
    // is held, so memory stays bounded by `permits × max-bytes-per-request`.
    await requestSemaphore.acquire();

    try {
      const upstreamHeaders: Record<string, string> = {
        "content-type": contentType,
        "x-superlog-project-id": projectId,
      };
      if (contentEncoding) upstreamHeaders["content-encoding"] = contentEncoding;

      // Counter is best-effort — never block the ingest hot path on a metric or DB lookup.
      void recordIngestRequest(path, projectId).catch((err: unknown) => {
        logger.warn({ err, path, projectId }, "tenant counter increment failed");
      });

      const bodyStream = requestBodyStream(c);
      if (!bodyStream) {
        responseStatus = 400;
        span.setAttribute("ingest.empty_body", true);
        logger.warn({ path, projectId }, "dropping OTLP request with no body");
        return c.json({ error: "empty OTLP request body; no records to ingest" }, 400);
      }

      // Issue-fingerprint stamping deserializes the whole payload, so in queue mode it runs
      // on the consumer (ingest-queue.ts) right before the collector POST — not here on the
      // latency-critical ingest edge. The proxy streams raw bytes: small bodies are buffered
      // and enqueued inline, larger ones stream straight to S3, so memory per request stays
      // bounded regardless of body size. A body over the cap → 413; an empty one → 400.
      if (ingestQueue) {
        let result: { storage: "inline" | "s3"; bytes: number };
        try {
          result = await tracer.startActiveSpan("ingest.queue_send", async (queueSpan) => {
            try {
              const r = await ingestQueue.enqueueStream({
                path,
                projectId,
                contentType,
                contentEncoding,
                body: bodyStream,
              });
              queueSpan.setAttribute("ingest.queue.storage", r.storage);
              return r;
            } catch (err) {
              queueSpan.recordException(err as Error);
              queueSpan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
              throw err;
            } finally {
              queueSpan.end();
            }
          });
        } catch (err) {
          const handled = handleIngestBodyError(err, c, span, path, projectId);
          if (handled) {
            responseStatus = handled.status;
            return handled.response;
          }
          throw err;
        }
        storage = result.storage;
        requestBytes = result.bytes;

        span.setAttribute("ingest.queue.enabled", true);
        span.setAttribute("ingest.queue.storage", storage);
        responseStatus = 200;
        logger.info({ path, projectId, storage }, "queued ingest payload");
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { "content-type": "application/x-protobuf" },
        });
      }

      // No queue (local dev / community direct mode): there is no consumer to stamp
      // fingerprints and no S3 to spill to, so buffer the body (bounded by the cap → 413)
      // and forward it straight to the collector. Memory here is bounded by
      // `permits × MAX_BODY_BYTES`; operators on small boxes should size those envs down.
      let bodyBuffer: Buffer;
      try {
        bodyBuffer = await collectStreamWithCap(bodyStream, MAX_BODY_BYTES);
      } catch (err) {
        const handled = handleIngestBodyError(err, c, span, path, projectId);
        if (handled) {
          responseStatus = handled.status;
          return handled.response;
        }
        throw err;
      }
      requestBytes = bodyBuffer.byteLength;

      const stampedBody = stampIssueFingerprintsFailOpen(
        { path, contentType, contentEncoding, body: bodyBuffer, projectId },
        logger,
      );
      const res = await tracer.startActiveSpan("ingest.collector_post", async (postSpan) => {
        postSpan.setAttribute("upstream.url", `${COLLECTOR_URL}${path}`);
        try {
          const r = await fetch(`${COLLECTOR_URL}${path}`, {
            method: "POST",
            headers: upstreamHeaders,
            body: stampedBody,
          });
          postSpan.setAttribute("http.response.status_code", r.status);
          if (r.status >= 400) {
            postSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: `upstream collector returned ${r.status}`,
            });
          }
          return r;
        } catch (err) {
          postSpan.recordException(err as Error);
          postSpan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          postSpan.end();
        }
      });

      span.setAttribute("http.response.status_code", res.status);
      responseStatus = res.status;
      logger.info({ path, projectId, status: res.status }, "proxied");

      const resHeaders = new Headers();
      const ct = res.headers.get("content-type");
      if (ct) resHeaders.set("content-type", ct);

      return new Response(res.body, { status: res.status, headers: resHeaders });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      // Release the permit once the body is fully read and forwarded. Released on
      // every path (success, 4xx, throw) so a failing request can't leak permits
      // and wedge the proxy into permanent backpressure.
      requestSemaphore.release();

      const durationMs = performance.now() - startedAt;
      const emitOperationalMetric = (org?: { orgId: string; orgName: string } | null) => {
        proxyOperationalRecorder.recordIngestRequest({
          path,
          projectId,
          orgId: org?.orgId,
          orgName: org?.orgName,
          statusCode: responseStatus,
          durationMs,
          requestBytes,
          storage,
        });
      };
      void lookupOrgForProject(projectId)
        .then((org) => emitOperationalMetric(org))
        .catch((err: unknown) => {
          logger.warn({ err, path, projectId }, "proxy ingest operational metric failed");
          emitOperationalMetric();
        });
      span.end();
    }
  });
}

const server = serve({ fetch: app.fetch, port: PORT });
// The proxy sits behind an ALB with a 60s idle timeout. Node's default
// keepAliveTimeout is 5s, so Node closes idle keep-alive sockets the ALB still
// considers pooled; when the ALB reuses one it gets a RST and surfaces an
// HTTPCode_ELB_502 (a TargetConnectionError) to the client even though the app
// returned 200. Periodic OTLP metric exporters (default ~60s interval) hit this
// race the hardest. Keep the target keep-alive above the ALB idle timeout, and
// headersTimeout above keepAliveTimeout per Node's required ordering.
if ("keepAliveTimeout" in server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
if (ingestQueue && ingestQueueConfig?.consumerEnabled) {
  ingestQueue.startConsumer(COLLECTOR_URL);
}
logger.info(
  {
    port: PORT,
    collector: COLLECTOR_URL,
    ingestQueueEnabled: Boolean(ingestQueue),
    ingestQueueConsumerEnabled: Boolean(ingestQueue && ingestQueueConfig?.consumerEnabled),
  },
  "superlog proxy listening",
);
