// OpenTelemetry bootstrap. Loaded via `node --import ./tracing.ts` (or tsx).
// Loads dotenv first so OTEL_* env vars set in .env / .env.superlog / .env.local
// are visible before the SDK reads process.env. Uses HTTP/protobuf exporters (no gRPC).
import { config as dotenvConfig } from "dotenv";
const portlessPort = process.env.PORTLESS_URL ? process.env.PORT : undefined;
dotenvConfig({ path: ".env.superlog" });
dotenvConfig();
dotenvConfig({ path: ".env.local", override: true });
if (process.env.SUPERLOG_ENV_FILE) {
  dotenvConfig({ path: process.env.SUPERLOG_ENV_FILE, override: true });
}
if (portlessPort) process.env.PORT = portlessPort;

// Always stamp an `env` resource attribute so every span/log/metric we emit is
// filterable by deployment environment. SUPERLOG_ENV is the explicit knob;
// RAILWAY_ENVIRONMENT_NAME / NODE_ENV are the fallbacks; "development" is the
// last resort so we never emit telemetry without an env.
const deploymentEnv =
  process.env.SUPERLOG_ENV ||
  process.env.RAILWAY_ENVIRONMENT_NAME ||
  process.env.NODE_ENV ||
  "development";

// Only ship telemetry from prod. Local dev (any non-production env) is muted
// so worktrees, branch checkouts, etc. don't pollute the prod Superlog
// project — see incident 779a80aa where local ECONNREFUSED storms were
// counted against an unrelated prod incident. Setting OTEL_SDK_DISABLED
// before any OTel import makes NodeSDK.start() a no-op; we also skip the
// manually-wired LoggerProvider below so its BatchLogRecordProcessor never
// starts. To dogfood from a local checkout, set SUPERLOG_ENV=production in
// apps/proxy/.env.local.
const telemetryEnabled = deploymentEnv === "production";
if (!telemetryEnabled) {
  process.env.OTEL_SDK_DISABLED = "true";
  console.warn(
    `[otel] deployment env is "${deploymentEnv}" — telemetry disabled (set SUPERLOG_ENV=production to enable)`,
  );
}

import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { setTelemetryShutdown } from "./src/telemetry-shutdown.js";

if (process.env.OTEL_DIAG_DEBUG === "1") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

if (telemetryEnabled) {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? "@superlog/proxy";
  const serviceInstanceId =
    process.env.OTEL_SERVICE_INSTANCE_ID ||
    process.env.RAILWAY_REPLICA_ID ||
    process.env.RAILWAY_DEPLOYMENT_ID ||
    process.env.HOSTNAME;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "";

  // OTel uses "k1=v1,k2=v2" in OTEL_EXPORTER_OTLP_HEADERS. Convert to a record
  // so we can hand it to the exporter constructor. The SDK already does this
  // for some signals, but being explicit is safer across exporter versions.
  const headers: Record<string, string> = {};
  for (const pair of rawHeaders.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) headers[key] = value;
  }

  const traceExporter = new OTLPTraceExporter({
    url: endpoint ? `${endpoint.replace(/\/$/, "")}/v1/traces` : undefined,
    headers,
  });

  const metricExporter = new OTLPMetricExporter({
    url: endpoint ? `${endpoint.replace(/\/$/, "")}/v1/metrics` : undefined,
    headers,
  });

  const logExporter = new OTLPLogExporter({
    url: endpoint ? `${endpoint.replace(/\/$/, "")}/v1/logs` : undefined,
    headers,
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    "deployment.environment.name": deploymentEnv,
    env: deploymentEnv,
    ...(serviceInstanceId ? { "service.instance.id": serviceInstanceId } : {}),
  });

  // SDK-Node owns traces + metrics. Logs we wire up manually so we can register
  // a global LoggerProvider for `@opentelemetry/api-logs` consumers.
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(logExporter)],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs is extremely chatty in dev (every tsx watch reload).
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = async () => {
    try {
      await sdk.shutdown();
      await loggerProvider.shutdown();
    } catch (err) {
      // Don't crash shutdown on a flush failure.
      console.error("[otel] shutdown error", err);
    }
  };

  // Do NOT register a SIGTERM/SIGINT handler here. The app's shutdown sequence
  // (apps/proxy/src/index.ts) owns the signals and invokes this flush AFTER it
  // drains in-flight ingest work. A second handler here used to process.exit(0)
  // as soon as the OTel flush finished, killing the process before the slower
  // SQS drain completed — orphaning in-flight messages on every deploy.
  setTelemetryShutdown(shutdown);
}
