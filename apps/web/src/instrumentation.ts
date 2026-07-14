// OpenTelemetry browser instrumentation. Loaded as the first import in main.tsx.
import { trace } from "@opentelemetry/api";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { UserInteractionInstrumentation } from "@opentelemetry/instrumentation-user-interaction";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

const endpoint = env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT;
const headersRaw = env.VITE_OTEL_EXPORTER_OTLP_HEADERS;
const serviceName = env.VITE_OTEL_SERVICE_NAME ?? "@superlog/web";
// Always stamp an `env` resource attribute so every browser span is filterable
// by deployment environment. VITE_SUPERLOG_ENV is the explicit knob; MODE is
// vite's build mode (production/development); "development" is the last resort.
const deploymentEnv = env.VITE_SUPERLOG_ENV || env.MODE || "development";

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return acc;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) acc[k] = v;
      return acc;
    }, {});
}

if (!endpoint) {
  // eslint-disable-next-line no-console
  console.warn(
    "[otel] VITE_OTEL_EXPORTER_OTLP_ENDPOINT not set; tracing disabled",
  );
} else {
  try {
    const headers = parseHeaders(headersRaw);

    const exporter = new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
      headers,
    });

    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        "deployment.environment.name": deploymentEnv,
        env: deploymentEnv,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });

    provider.register({
      contextManager: new ZoneContextManager(),
    });

    registerInstrumentations({
      instrumentations: [
        new DocumentLoadInstrumentation(),
        new UserInteractionInstrumentation(),
        new FetchInstrumentation({
          // Only propagate traceparent to first-party hosts. Third parties
          // Some third-party hosts reject traceparent in their CORS allowlist and
          // the preflight fails.
          propagateTraceHeaderCorsUrls: [/^https:\/\/(api|intake)\.superlog\.sh/],
          clearTimingResources: true,
        }),
      ],
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[otel] failed to initialize tracing", err);
  }
}

export const tracer = trace.getTracer("@superlog/web");
