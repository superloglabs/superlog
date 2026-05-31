import { metrics } from "@opentelemetry/api";

type MetricAttributes = Record<string, string | number | boolean>;

type CounterLike = {
  add(value: number, attributes?: MetricAttributes): void;
};

type HistogramLike = {
  record(value: number, attributes?: MetricAttributes): void;
};

type ProxyOperationalInstruments = {
  ingestRequests?: CounterLike;
  ingestDurationMs?: HistogramLike;
  ingestRequestBytes?: HistogramLike;
  queueMessages?: CounterLike;
  queueDeliveryDurationMs?: HistogramLike;
  queueMessageAgeMs?: HistogramLike;
};

export type IngestRequestMetricInput = {
  path: string;
  projectId: string;
  orgId?: string | null;
  orgName?: string | null;
  statusCode: number;
  durationMs: number;
  requestBytes: number;
  storage: "direct" | "inline" | "s3";
};

export type QueueDeliveryMetricInput = {
  path: string;
  projectId: string;
  storage: "inline" | "s3";
  outcome: "delivered" | "collector_error" | "invalid_message" | "delivery_error";
  collectorStatusCode?: number;
  durationMs: number;
  ageMs?: number;
};

const meter = metrics.getMeter("@superlog/proxy/operational");

function signalFromPath(path: string): string {
  if (path === "/v1/traces") return "traces";
  if (path === "/v1/logs") return "logs";
  if (path === "/v1/metrics") return "metrics";
  return "unknown";
}

function statusClass(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

function tenantAttrs(input: { path: string; projectId: string; orgId?: string | null; orgName?: string | null }) {
  const attrs: MetricAttributes = {
    "otlp.signal": signalFromPath(input.path),
    "tenant.project.id": input.projectId,
  };
  if (input.orgId) attrs["tenant.org.id"] = input.orgId;
  if (input.orgName) attrs["tenant.org.name"] = input.orgName;
  return attrs;
}

export function createProxyOperationalRecorder(instruments: ProxyOperationalInstruments) {
  return {
    recordIngestRequest(input: IngestRequestMetricInput): void {
      const attrs: MetricAttributes = {
        ...tenantAttrs(input),
        "http.response.status_code": input.statusCode,
        "http.response.status_class": statusClass(input.statusCode),
        "ingest.queue.storage": input.storage,
      };
      instruments.ingestRequests?.add(1, attrs);
      instruments.ingestDurationMs?.record(input.durationMs, attrs);
      instruments.ingestRequestBytes?.record(input.requestBytes, attrs);
    },

    recordQueueDelivery(input: QueueDeliveryMetricInput): void {
      const attrs: MetricAttributes = {
        ...tenantAttrs(input),
        "ingest.queue.storage": input.storage,
        "ingest.queue.outcome": input.outcome,
      };
      if (input.collectorStatusCode !== undefined) {
        attrs["collector.status_code"] = input.collectorStatusCode;
        attrs["collector.status_class"] = statusClass(input.collectorStatusCode);
      }
      instruments.queueMessages?.add(1, attrs);
      instruments.queueDeliveryDurationMs?.record(input.durationMs, attrs);
      if (input.ageMs !== undefined) instruments.queueMessageAgeMs?.record(input.ageMs, attrs);
    },
  };
}

export const proxyOperationalRecorder = createProxyOperationalRecorder({
  ingestRequests: meter.createCounter("superlog.proxy.ingest.requests", {
    description: "Proxy OTLP ingest requests by org, project, signal, status, and storage path.",
  }),
  ingestDurationMs: meter.createHistogram("superlog.proxy.ingest.duration_ms", {
    description: "Proxy OTLP ingest request duration in milliseconds.",
    unit: "ms",
  }),
  ingestRequestBytes: meter.createHistogram("superlog.proxy.ingest.request_bytes", {
    description: "Proxy OTLP ingest request body size in bytes.",
    unit: "By",
  }),
  queueMessages: meter.createCounter("superlog.proxy.queue.messages", {
    description: "Queued ingest payload delivery attempts by outcome.",
  }),
  queueDeliveryDurationMs: meter.createHistogram("superlog.proxy.queue.delivery.duration_ms", {
    description: "Queued ingest payload delivery duration in milliseconds.",
    unit: "ms",
  }),
  queueMessageAgeMs: meter.createHistogram("superlog.proxy.queue.message.age_ms", {
    description: "Queued ingest payload age when delivery is attempted.",
    unit: "ms",
  }),
});
