import "./env.js";
import { Readable } from "node:stream";
// Telemetry flush is owned by shutdown() below (the single SIGTERM owner), not by
// tracing.ts, so the OTel flush can't race the ingest drain and exit early.
import { shutdownTelemetry } from "./telemetry-shutdown.js";
import { serve } from "@hono/node-server";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { hashApiKey, schema, syncLoopsContactsForProject } from "@superlog/db";
import { db } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createIngestEntitlementGate, signalForPath } from "./billing/ingest-entitlement.js";
import { EmptyBodyError, PayloadTooLargeError } from "./body-capture.js";
import {
  FIREHOSE_ACCESS_KEY_HEADER,
  FIREHOSE_REQUEST_ID_HEADER,
  FIREHOSE_SOURCE_ARN_HEADER,
  buildFirehoseUpstreamHeaders,
  firehoseResponseBody,
  parseAccountIdFromFirehoseArn,
} from "./firehose.js";
import { stampIssueFingerprintsFailOpen } from "./ingest-fingerprints.js";
import {
  ClickHouseIngestWriter,
  getIngestClickHouseConfig,
} from "./clickhouse-writer.js";
import { IngestQueue, getIngestQueueConfig } from "./ingest-queue.js";
import {
  type TelemetrySignal,
  createIngestSourceFilter,
  ingestFilterKey,
} from "./ingest-source-filter.js";
import { authKeyCache } from "./auth-key-cache.js";
import { logger } from "./logger.js";
import { proxyOperationalRecorder } from "./operational-metrics.js";
import { Semaphore } from "./semaphore.js";
import { lookupOrgForProject, recordIngestRequest } from "./tenant-metrics.js";

const tracer = trace.getTracer("@superlog/proxy");

type Variables = { projectId: string };

const app = new Hono<{ Variables: Variables }>();

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://localhost:4318";
// The collector's `awsfirehose` receivers listen on their own ports — one per
// encoding, since a receiver decodes a single format: otlp_v1 for CloudWatch
// Metric Streams, cwlogs for the account-level Logs subscription filter.
// Defaults target the local stack; prod points these at the collector's
// internal endpoint.
const FIREHOSE_METRICS_COLLECTOR_URL =
  process.env.FIREHOSE_METRICS_COLLECTOR_URL ?? "http://localhost:4433";
const FIREHOSE_LOGS_COLLECTOR_URL =
  process.env.FIREHOSE_LOGS_COLLECTOR_URL ?? "http://localhost:4434";
const PORT = Number(process.env.PORT ?? 4000);
const ingestQueueConfig = getIngestQueueConfig(process.env);
// When INGEST_CLICKHOUSE_DIRECT=true, the consumer writes logs/traces straight to
// ClickHouse (parallel synchronous quorum inserts, acked on success) instead of
// forwarding every message through the collector. Metrics and undecodable bodies
// still fall through to the collector. Disabled (null) otherwise.
const ingestClickHouseConfig = getIngestClickHouseConfig(process.env);
// Only build the writer when a consumer will actually run (queue configured and the
// consumer enabled) — it's only used on the consume path, so creating/logging it for a
// producer-only proxy would be wasted setup and a false "enabled" rollout signal.
const ingestRowWriter =
  ingestClickHouseConfig && ingestQueueConfig?.consumerEnabled
    ? new ClickHouseIngestWriter(ingestClickHouseConfig)
    : undefined;
if (ingestRowWriter) {
  logger.info(
    { database: ingestClickHouseConfig?.database, insertQuorum: ingestClickHouseConfig?.insertQuorum },
    "ingest direct-to-clickhouse writes enabled for logs and traces",
  );
}
const ingestQueue = ingestQueueConfig
  ? new IngestQueue(ingestQueueConfig, logger, undefined, ingestRowWriter)
  : null;
// Free-tier ingest hard-block. Null (disabled) without AUTUMN_SECRET_KEY. The
// verdict is a cached, fail-open in-memory read — never a blocking call on the
// ingest hot path (see billing/ingest-entitlement.ts).
const ingestGate = createIngestEntitlementGate({ lookupOrgForProject });

// Per-project ingest source filters (OTLP vs AWS, per signal). Cached + fail-open
// in-memory read, same as the entitlement gate — a project's toggle ack-drops the
// disabled telemetry at the edge. Always on; the empty default ingests everything.
const ingestSourceFilter = createIngestSourceFilter({
  loadDisabled: async (projectId) => {
    const rows = await db.query.projectIngestFilters.findMany({
      where: eq(schema.projectIngestFilters.projectId, projectId),
      columns: { source: true, signal: true },
    });
    return new Set(rows.map((r) => ingestFilterKey(r.source, r.signal)));
  },
});

// Map an OTLP ingest path to its telemetry signal for the source filter.
function otlpSignalForPath(path: string): TelemetrySignal | null {
  if (path === "/v1/traces") return "traces";
  if (path === "/v1/logs") return "logs";
  if (path === "/v1/metrics") return "metrics";
  return null;
}

// Admission control is split into two lanes so a slow request can't head-of-line
// block a fast one waiting for the same permit. The body is only read once a
// permit is held, so each lane's memory is a provable constant (permits ×
// max-bytes-held) — a burst can never OOM-kill the task (exit 137, the
// 2026-05-31 incident). Excess requests WAIT for a permit (backpressure) rather
// than being rejected; waiters cost ~nothing (just a socket + pending promise).
//
//  - BUFFER lane: small bodies that buffer in memory and ship inline (the common
//    fast path), plus the direct-mode + Firehose paths that fully buffer. Memory
//    ≈ permits × max-bytes-held.
//  - UPLOAD lane: oversize bodies that stream to S3 via a multi-second multipart
//    upload. These held a permit far longer than their memory cost justified
//    (one 5 MiB part), so under an oversize burst they used to starve the buffer
//    lane and stall small, latency-sensitive requests past their client timeout.
//    A separate pool isolates that slow work. Memory ≈ permits × part.
//
// The request edge routes by Content-Length (ingestQueue.laneForContentLength).
// Default 64 each; tune via INGEST_MAX_INFLIGHT_REQUESTS / INGEST_MAX_INFLIGHT_UPLOADS,
// or set to 0 to disable a lane's limiter.
const DEFAULT_MAX_INFLIGHT_REQUESTS = 64;
const DEFAULT_MAX_INFLIGHT_UPLOADS = 64;
const MAX_INFLIGHT_REQUESTS = readNonNegativeIntEnv(
  process.env.INGEST_MAX_INFLIGHT_REQUESTS,
  DEFAULT_MAX_INFLIGHT_REQUESTS,
);
const MAX_INFLIGHT_UPLOADS = readNonNegativeIntEnv(
  process.env.INGEST_MAX_INFLIGHT_UPLOADS,
  DEFAULT_MAX_INFLIGHT_UPLOADS,
);
const bufferSemaphore = new Semaphore(MAX_INFLIGHT_REQUESTS);
const uploadSemaphore = new Semaphore(MAX_INFLIGHT_UPLOADS);
const ingestLaneSemaphores = { buffer: bufferSemaphore, upload: uploadSemaphore } as const;

// Per-lane admission gauges, so an oversize burst that drains the upload lane and
// backs up its waiter queue is visible instead of inferred. available_permits
// hitting 0 with a rising queue_depth on a lane = that lane is the bottleneck.
const ingestMeter = metrics.getMeter("@superlog/proxy");
ingestMeter
  .createObservableGauge("superlog.proxy.ingest.admission.available_permits", {
    description: "Free admission permits per ingest lane (0 = lane saturated).",
  })
  .addCallback((observer) => {
    observer.observe(bufferSemaphore.availablePermits, { "ingest.lane": "buffer" });
    observer.observe(uploadSemaphore.availablePermits, { "ingest.lane": "upload" });
  });
ingestMeter
  .createObservableGauge("superlog.proxy.ingest.admission.queue_depth", {
    description: "Requests waiting for an admission permit per ingest lane (backpressure depth).",
  })
  .addCallback((observer) => {
    observer.observe(bufferSemaphore.queueLength, { "ingest.lane": "buffer" });
    observer.observe(uploadSemaphore.queueLength, { "ingest.lane": "upload" });
  });

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

      const keyHash = hashApiKey(key);
      const cached = authKeyCache.get(keyHash);
      let projectId: string;

      if (cached !== null) {
        // Cache hit — skip Postgres entirely. Bounded revocation lag ≤ 60 s is
        // acceptable; only valid keys are cached so revocations take effect on
        // the next DB read (when the cached entry expires).
        span.setAttribute("auth.cache", "hit");
        projectId = cached;
      } else {
        const row = await db.query.apiKeys.findFirst({
          where: eq(schema.apiKeys.keyHash, keyHash),
        });
        if (!row || row.revokedAt) {
          span.setAttribute("auth.result", "invalid_key");
          span.setStatus({ code: SpanStatusCode.ERROR, message: "invalid api key" });
          return c.json({ error: "invalid api key" }, 401);
        }
        projectId = row.projectId;
        authKeyCache.set(keyHash, projectId);
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
      }

      span.setAttribute("auth.result", "ok");
      span.setAttribute("tenant.project_id", projectId);
      c.set("projectId", projectId);

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

// AWS Data Firehose HTTP-endpoint ingest (CloudWatch Metric Streams + Logs).
// Firehose authenticates with X-Amz-Firehose-Access-Key (the project's ingest
// key) rather than the x-api-key/Bearer header the /v1/* OTLP middleware reads,
// so these routes resolve the tenant themselves. See forwardFirehose.
app.post("/aws/firehose/metrics", (c) =>
  forwardFirehose(c, FIREHOSE_METRICS_COLLECTOR_URL, "metrics"),
);
app.post("/aws/firehose/logs", (c) => forwardFirehose(c, FIREHOSE_LOGS_COLLECTOR_URL, "logs"));

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

    // Route into the matching admission lane by declared body size, so a slow
    // oversize S3 upload can't head-of-line block a tiny request. Unknown size
    // (no Content-Length) defaults to the buffer lane; if such a body actually
    // spills, captureBody still handles it correctly — only the lane differs.
    // Direct mode (no queue, no S3) always uses the buffer lane.
    const declaredContentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
    const lane = ingestQueue
      ? ingestQueue.laneForContentLength(
          Number.isNaN(declaredContentLength) ? undefined : declaredContentLength,
        )
      : "buffer";
    span.setAttribute("ingest.lane", lane);

    span.setAttribute("otlp.path", path);
    span.setAttribute("otlp.root_key", rootKey);
    span.setAttribute("tenant.project_id", projectId);
    span.setAttribute("http.request.content_type", contentType);
    if (contentEncoding) span.setAttribute("http.request.content_encoding", contentEncoding);

    // Wait for a permit in this request's lane before touching the body. Excess
    // requests queue here cheaply (just a pending promise + their socket) instead
    // of being rejected — backpressure, not shedding. The body is only read once a
    // permit is held, so memory stays bounded by `permits × max-bytes-per-request`.
    await ingestLaneSemaphores[lane].acquire();

    try {
      // Per-project source filter FIRST: if the project turned off its OTLP
      // source for this signal, ack-drop with a 200 (the drop is the user's
      // intent). This precedes the quota gate so a disabled source is always a
      // clean 200, never a 402 the exporter would retry against.
      const otlpSignal = otlpSignalForPath(path);
      if (otlpSignal && !ingestSourceFilter.allows(projectId, "otlp", otlpSignal)) {
        responseStatus = 200;
        span.setAttribute("ingest.dropped", "source_filtered");
        logger.info(
          { path, projectId, signal: otlpSignal },
          "dropping OTLP ingest; source disabled",
        );
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { "content-type": "application/x-protobuf" },
        });
      }

      // Free-tier hard-block: if the org has exhausted its monthly allowance for
      // this signal, drop with a non-retryable 4xx (402) so OTLP exporters stop
      // sending rather than retry-storm. Cached + fail-open, so this is a cheap
      // in-memory read that never blocks on Autumn.
      const signal = signalForPath(path);
      if (ingestGate && signal && !ingestGate.allows(projectId, signal)) {
        responseStatus = 402;
        span.setAttribute("ingest.blocked", "quota_exceeded");
        logger.info({ path, projectId, signal }, "blocking ingest; org over plan quota");
        return c.json(
          {
            error:
              "telemetry quota exceeded for this billing period; upgrade your plan to resume ingest",
          },
          402,
        );
      }

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
      // Release the lane's permit once the body is fully read and forwarded.
      // Released on every path (success, 4xx, throw) so a failing request can't
      // leak permits and wedge the proxy into permanent backpressure.
      ingestLaneSemaphores[lane].release();

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
          lane,
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

/**
 * Resolve an ingest key to its project id, mirroring the /v1/* OTLP auth
 * middleware (hash lookup, reject revoked). Returns null when the key is
 * unknown or revoked. Bumps last_used_at best-effort so a project's key
 * activity reflects Firehose ingest too — but skips the first-use Loops nudge,
 * which the OTLP path already owns.
 */
async function resolveProjectIdForIngestKey(key: string): Promise<string | null> {
  const row = await db.query.apiKeys.findFirst({
    where: eq(schema.apiKeys.keyHash, hashApiKey(key)),
  });
  if (!row || row.revokedAt) return null;
  void db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, row.id))
    .catch((err: unknown) => {
      logger.warn({ err }, "failed to update last_used_at for firehose key");
    });
  return row.projectId;
}

/**
 * Forward an AWS Data Firehose HTTP-endpoint batch to the collector's
 * `awsfirehose` receiver. The proxy authenticates (X-Amz-Firehose-Access-Key →
 * project), stamps the tenant header, forwards the required request id, and
 * passes the collector's Firehose ack straight back — Option A from the spike:
 * the receiver decodes the records and builds the `{requestId,timestamp}` ack
 * itself.
 *
 * Firehose treats only a 200 as success; any other status is retried with
 * back-off and, after the configured window, dropped to the customer's error
 * bucket with the errorMessage we return. So every rejection returns a
 * Firehose-spec body carrying the request id.
 */
async function forwardFirehose(
  c: Context<{ Variables: Variables }>,
  collectorUrl: string,
  signal: "metrics" | "logs",
) {
  return tracer.startActiveSpan("ingest.firehose", async (span) => {
    const requestId = c.req.header(FIREHOSE_REQUEST_ID_HEADER) ?? null;
    const contentType = c.req.header("content-type") ?? "application/json";
    const contentEncoding = c.req.header("content-encoding");
    span.setAttribute("firehose.signal", signal);
    span.setAttribute("firehose.has_request_id", requestId !== null);

    // The source ARN's account id lets us (later) cross-check the stream against
    // the project's cloud connection. For now record it for observability;
    // tenancy is already pinned by the access key.
    const sourceAccountId = parseAccountIdFromFirehoseArn(c.req.header(FIREHOSE_SOURCE_ARN_HEADER));
    if (sourceAccountId) span.setAttribute("firehose.source_account_id", sourceAccountId);

    const fail = (status: 400 | 401 | 402 | 413 | 500, message: string) => {
      span.setAttribute("firehose.result", `error_${status}`);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      logger.warn({ signal, requestId, status, message }, "rejecting firehose batch");
      return c.json(firehoseResponseBody(requestId ?? "unknown", message), status);
    };

    try {
      // The receiver requires the request id; fail fast rather than forward a
      // request it would 400 anyway.
      if (!requestId) return fail(400, "missing X-Amz-Firehose-Request-Id header");

      const key = c.req.header(FIREHOSE_ACCESS_KEY_HEADER);
      if (!key) return fail(401, "missing X-Amz-Firehose-Access-Key header");

      const projectId = await resolveProjectIdForIngestKey(key);
      if (!projectId) return fail(401, "invalid api key");
      span.setAttribute("tenant.project_id", projectId);

      // Per-project source filter FIRST: if the project turned off its AWS
      // source for this signal, ack-drop with a 200 success ack so Firehose
      // treats it as delivered and doesn't retry into the customer's error
      // bucket. This precedes the quota gate so disabling a source always wins
      // over a 402 — otherwise a disabled-AND-over-quota stream would retry-storm
      // and error-bucket, the exact outcome turning the source off should avoid.
      if (!ingestSourceFilter.allows(projectId, "aws", signal)) {
        span.setAttribute("ingest.dropped", "source_filtered");
        span.setAttribute("firehose.result", "dropped");
        logger.info({ signal, projectId, requestId }, "dropping firehose batch; source disabled");
        return c.json(firehoseResponseBody(requestId), 200);
      }

      // Free-tier hard-block, same gate the OTLP path enforces — otherwise an
      // over-quota org could keep streaming CloudWatch metrics/logs through
      // Firehose. Cached + fail-open, so this is a cheap in-memory read. A 402 is
      // a non-2xx to Firehose, so it backs off and (after the window) drops to
      // the customer's error bucket rather than delivering.
      const entitlementSignal = signal === "metrics" ? "metric_points" : "logs";
      if (ingestGate && !ingestGate.allows(projectId, entitlementSignal)) {
        span.setAttribute("ingest.blocked", "quota_exceeded");
        return fail(
          402,
          "telemetry quota exceeded for this billing period; upgrade your plan to resume ingest",
        );
      }

      const upstreamHeaders = buildFirehoseUpstreamHeaders({
        projectId,
        requestId,
        contentType,
        contentEncoding,
      });
      if (!upstreamHeaders) return fail(400, "missing X-Amz-Firehose-Request-Id header");

      // Firehose batches fully buffer (no S3 spill), so they belong in the
      // buffer lane alongside the other memory-bounded buffered paths.
      await bufferSemaphore.acquire();
      try {
        const bodyStream = requestBodyStream(c);
        if (!bodyStream) return fail(400, "empty Firehose request body");

        let bodyBuffer: Buffer;
        try {
          bodyBuffer = await collectStreamWithCap(bodyStream, MAX_BODY_BYTES);
        } catch (err) {
          // 413 is a permanent failure to Firehose (not sent to the error
          // bucket); an empty body is a 400. Anything else rethrows → 500.
          if (err instanceof PayloadTooLargeError) {
            return fail(413, `request body exceeds the ${err.limitBytes}-byte limit`);
          }
          if (err instanceof EmptyBodyError) return fail(400, "empty Firehose request body");
          throw err;
        }

        const res = await tracer.startActiveSpan(
          "ingest.firehose.collector_post",
          async (postSpan) => {
            postSpan.setAttribute("upstream.url", collectorUrl);
            try {
              const r = await fetch(collectorUrl, {
                method: "POST",
                headers: upstreamHeaders,
                body: bodyBuffer,
              });
              postSpan.setAttribute("http.response.status_code", r.status);
              if (r.status !== 200) {
                postSpan.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: `collector firehose receiver returned ${r.status}`,
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
          },
        );

        span.setAttribute("http.response.status_code", res.status);
        span.setAttribute("firehose.result", res.status === 200 ? "ok" : `collector_${res.status}`);
        logger.info({ signal, projectId, status: res.status }, "proxied firehose batch");

        // Pass the receiver's ack through verbatim — it owns the
        // {requestId,timestamp} body and the application/json content-type.
        const resHeaders = new Headers();
        resHeaders.set("content-type", res.headers.get("content-type") ?? "application/json");
        return new Response(res.body, { status: res.status, headers: resHeaders });
      } finally {
        bufferSemaphore.release();
      }
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      // Keep the detailed error server-side only — the errorMessage we return is
      // echoed by AWS into the customer's Firehose error logs / S3 error bucket,
      // so it must not carry internal exception text (collector URLs, stack info).
      logger.error({ err, signal, requestId }, "firehose proxy request failed");
      // 500 (retriable) with a Firehose-shaped body so AWS backs off and retries.
      return c.json(
        firehoseResponseBody(requestId ?? "unknown", "internal error processing firehose request"),
        500,
      );
    } finally {
      span.end();
    }
  });
}

const server = serve({ fetch: app.fetch, port: PORT });
// When deployed behind a load balancer (typically a 60s idle timeout), Node's
// default 5s keepAliveTimeout closes idle keep-alive sockets the balancer still
// considers pooled; reusing one then gets a RST and surfaces as a 502 to the
// client even though the app returned 200. Periodic OTLP metric exporters
// (default ~60s interval) hit this race the hardest. Keep the keep-alive
// comfortably above the balancer idle timeout: a thin (~5s) margin still leaks
// 502s in bursts where many wall-clock-aligned exporters reuse pooled sockets at
// once and the event loop is briefly busy, so we keep a wide margin. headersTimeout
// stays above keepAliveTimeout per Node's required ordering.
if ("keepAliveTimeout" in server) {
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 76_000;
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

// Drain gracefully on the SIGTERM an ECS rolling deploy sends before SIGKILL:
// stop accepting new HTTP requests, then let the queue consumer finish (and
// delete) its in-flight messages. Without this the task is killed mid-batch and
// the received-but-undeleted SQS messages stay invisible for the full visibility
// timeout before redelivering — the sawtooth that pins ApproximateAgeOfOldestMessage
// and trips the ingest-lag page on every deploy. ECS's stopTimeout bounds how long
// we get; the consumer aborts its idle long-poll so the drain is fast in practice.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "received shutdown signal; draining");
  try {
    await new Promise<void>((resolve) => {
      if ("close" in server && typeof server.close === "function") {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
    // stop() also flushes any sends still waiting on the batching linger, so a
    // producer-only proxy (consumer disabled) must call it too.
    if (ingestQueue) {
      await ingestQueue.stop();
    }
    // Flush telemetry LAST, after the ingest drain. tracing.ts no longer
    // registers its own SIGTERM handler — it used to race this one and
    // process.exit(0) mid-drain, orphaning in-flight SQS messages.
    await shutdownTelemetry();
  } catch (err) {
    // Exit non-zero so a failed drain is visible rather than masquerading as a
    // clean stop.
    logger.error({ err }, "error during graceful shutdown");
    process.exit(1);
  }
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
