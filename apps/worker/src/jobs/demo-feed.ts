// Rolling telemetry feed for the shared demo project.
//
// Demo mode lets a brand-new user explore a populated product before they
// instrument anything: the API serves them a hidden, curated demo project's
// data (read-only). This job keeps that project's telemetry feeling LIVE —
// every couple of minutes it appends a fresh burst of traces / INFO-WARN logs /
// gauge metrics (timestamped ~now) and trims rows past the retention window, so
// charts move and "last 1h" views stay populated.
//
// Deliberately emits NO span `exception` events and NO ERROR/SeverityNumber>=17
// logs: issues/incidents are minted only from those, and the demo's incidents
// are a curated, hand-written set (see scripts/demo/provision-demo-project.ts).
// Keeping the live feed clean means the worker never manufactures competing
// low-quality issues on top of the curated set.
//
// Opt-in: the job only schedules when DEMO_PROJECT_ID and DEMO_COLLECTOR_URL are
// set, so stock / self-host builds schedule nothing.

import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

const SERVICES = ["checkout-api", "catalog-api", "payments-api", "web", "worker"] as const;
const REGIONS = ["us-east-1", "us-west-2", "eu-west-1"] as const;
const SPAN_NAMES = ["GET /cart", "POST /checkout", "GET /products", "POST /pay", "GET /health"];
const LOG_LINES = [
  "request completed",
  "cache hit",
  "order placed",
  "payment authorized",
  "inventory reserved",
  "rate limit near threshold",
];
const METRICS = [
  { name: "http.server.duration", unit: "ms", base: 120, spread: 80 },
  { name: "http.server.requests", unit: "1", base: 40, spread: 30 },
  { name: "process.memory.usage", unit: "By", base: 256_000_000, spread: 40_000_000 },
] as const;
// Retention window for demo telemetry — anything older is trimmed each tick.
const RETENTION_HOURS = 24;

const HEX = "0123456789abcdef";
function hex(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += HEX[Math.floor(Math.random() * 16)];
  return s;
}
const nanos = (ms: number) => String(Math.trunc(ms) * 1_000_000);
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;

function resourceFor(service: string) {
  return {
    attributes: [
      attr("service.name", service),
      attr("cloud.region", pick(REGIONS)),
      attr("deployment.environment", "production"),
    ],
  };
}

export type DemoBatch = {
  traces: unknown;
  logs: unknown;
  metrics: unknown;
};

// Pure: build one fresh burst of OTLP/HTTP JSON payloads anchored at `nowMs`.
// `superlog.project_id` is intentionally NOT set here — the collector promotes
// it from the x-superlog-project-id ingest header (anti-spoofing).
export function buildDemoBatch(nowMs: number, perService = 6): DemoBatch {
  const resourceSpans = SERVICES.map((service) => ({
    resource: resourceFor(service),
    scopeSpans: [
      {
        scope: { name: "demo.feed" },
        spans: Array.from({ length: perService }, () => {
          const start = nowMs - Math.floor(Math.random() * 60_000);
          const durationMs = 20 + Math.floor(Math.random() * 400);
          return {
            traceId: hex(32),
            spanId: hex(16),
            name: pick(SPAN_NAMES),
            kind: 2, // SERVER
            startTimeUnixNano: nanos(start),
            endTimeUnixNano: nanos(start + durationMs),
            attributes: [
              attr("http.method", pick(["GET", "POST"])),
              attr("http.status_code", pick(["200", "200", "200", "201", "204"])),
            ],
            status: { code: 1 }, // OK — never Error, never an exception event
          };
        }),
      },
    ],
  }));

  const resourceLogs = SERVICES.map((service) => ({
    resource: resourceFor(service),
    scopeLogs: [
      {
        scope: { name: "demo.feed" },
        logRecords: Array.from({ length: perService }, () => {
          // INFO (9) most of the time, WARN (13) occasionally. Never >= 17 (ERROR).
          const warn = Math.random() < 0.15;
          return {
            timeUnixNano: nanos(nowMs - Math.floor(Math.random() * 60_000)),
            severityNumber: warn ? 13 : 9,
            severityText: warn ? "WARN" : "INFO",
            body: { stringValue: pick(LOG_LINES) },
            attributes: [attr("http.route", pick(SPAN_NAMES))],
          };
        }),
      },
    ],
  }));

  const resourceMetrics = SERVICES.map((service) => ({
    resource: resourceFor(service),
    scopeMetrics: [
      {
        scope: { name: "demo.feed" },
        metrics: METRICS.map((m) => ({
          name: m.name,
          unit: m.unit,
          gauge: {
            dataPoints: [
              {
                timeUnixNano: nanos(nowMs),
                asDouble: m.base + (Math.random() - 0.5) * m.spread,
                attributes: [attr("http.method", pick(["GET", "POST"]))],
              },
            ],
          },
        })),
      },
    ],
  }));

  return {
    traces: { resourceSpans },
    logs: { resourceLogs },
    metrics: { resourceMetrics },
  };
}

async function postSignal(
  collectorUrl: string,
  projectId: string,
  signal: "traces" | "logs" | "metrics",
  payload: unknown,
): Promise<void> {
  const res = await fetch(`${collectorUrl.replace(/\/$/, "")}/v1/${signal}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-superlog-project-id": projectId,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`collector ${signal} ingest failed: ${res.status} ${await res.text()}`);
  }
}

async function trimOldTelemetry(deps: JobDeps, projectId: string): Promise<void> {
  const cutoff = `now() - INTERVAL ${RETENTION_HOURS} HOUR`;
  const tables: Array<{ table: string; tsCol: string }> = [
    { table: "otel_traces", tsCol: "Timestamp" },
    { table: "otel_logs", tsCol: "Timestamp" },
    { table: "otel_metrics_gauge", tsCol: "TimeUnix" },
  ];
  for (const { table, tsCol } of tables) {
    await deps.clickhouse.command({
      query: `ALTER TABLE ${table} DELETE WHERE ResourceAttributes['superlog.project_id'] = {projectId:String} AND ${tsCol} < ${cutoff}`,
      query_params: { projectId },
    });
  }
}

export const job: JobDefinition = {
  name: "demo-feed",
  // Every 2 minutes — fine-grained enough that "last 5m" / "last 1h" views stay
  // alive without flooding the project.
  schedule: "*/2 * * * *",
  create: (deps: JobDeps) => {
    const projectId = process.env.DEMO_PROJECT_ID?.trim();
    const collectorUrl = process.env.DEMO_COLLECTOR_URL?.trim();
    if (!projectId || !collectorUrl) return null; // opt out: not a demo deployment

    return async () => {
      const batch = buildDemoBatch(Date.now());
      await postSignal(collectorUrl, projectId, "traces", batch.traces);
      await postSignal(collectorUrl, projectId, "logs", batch.logs);
      await postSignal(collectorUrl, projectId, "metrics", batch.metrics);
      await trimOldTelemetry(deps, projectId).catch((err) => {
        // Trim is best-effort: a failed retention pass must not fail the feed.
        logger.warn(
          { scope: "jobs.demo-feed", err: err instanceof Error ? err.message : String(err) },
          "demo-feed retention trim failed",
        );
      });
      logger.info({ scope: "jobs.demo-feed", projectId }, "demo telemetry feed tick complete");
    };
  },
};
