import "./env.js";
import { serve } from "@hono/node-server";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { hashApiKey, schema, syncLoopsContactsForProject } from "@superlog/db";
import { db } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { stampIssueFingerprintsFailOpen } from "./ingest-fingerprints.js";
import { IngestQueue, getIngestQueueConfig } from "./ingest-queue.js";
import { logger } from "./logger.js";
import { proxyOperationalRecorder } from "./operational-metrics.js";
import { lookupOrgForProject, recordIngestRequest } from "./tenant-metrics.js";

const tracer = trace.getTracer("@superlog/proxy");

type Variables = { projectId: string };

const app = new Hono<{ Variables: Variables }>();

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://localhost:4318";
const PORT = Number(process.env.PORT ?? 4000);
const ingestQueueConfig = getIngestQueueConfig(process.env);
const ingestQueue = ingestQueueConfig ? new IngestQueue(ingestQueueConfig, logger) : null;

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

      const body = await c.req.arrayBuffer();
      const bodyBuffer = Buffer.from(body);
      requestBytes = bodyBuffer.byteLength;

      // Some OTLP/HTTP exporters (observed: a Bun fetch-based logs exporter) periodically
      // POST a zero-byte body — an empty export carrying no records. There is nothing to
      // forward, and enqueuing it only poisons the ingest queue: the consumer rejects an
      // empty payload and it churns through redeliveries until it reaches the DLQ. Drop it
      // here with a 4xx (which OTLP exporters treat as non-retryable, so no retry storm).
      if (bodyBuffer.byteLength === 0) {
        responseStatus = 400;
        span.setAttribute("ingest.empty_body", true);
        logger.warn({ path, projectId }, "dropping empty OTLP request body");
        return c.json({ error: "empty OTLP request body; no records to ingest" }, 400);
      }

      // Issue-fingerprint stamping deserializes the whole payload, so it now runs on the
      // consumer (ingest-queue.ts) right before the collector POST — not here on the
      // latency-critical, shared-event-loop ingest edge. The proxy just enqueues raw bytes.
      if (ingestQueue) {
        storage = await tracer.startActiveSpan("ingest.queue_send", async (queueSpan) => {
          try {
            const result = await ingestQueue.enqueue({
              path,
              projectId,
              contentType,
              contentEncoding,
              body: bodyBuffer,
            });
            queueSpan.setAttribute("ingest.queue.storage", result);
            return result;
          } catch (err) {
            queueSpan.recordException(err as Error);
            queueSpan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
            throw err;
          } finally {
            queueSpan.end();
          }
        });

        span.setAttribute("ingest.queue.enabled", true);
        span.setAttribute("ingest.queue.storage", storage);
        responseStatus = 200;
        logger.info({ path, projectId, storage }, "queued ingest payload");
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { "content-type": "application/x-protobuf" },
        });
      }

      // No queue (local dev): forward straight to the collector, stamping inline here since
      // there is no consumer to do it. Size-guarded + fail-open inside the helper.
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
