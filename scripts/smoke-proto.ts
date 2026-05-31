import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const url = process.env.OTLP_URL ?? "http://localhost:4000/v1/traces";
const key = process.env.SUPERLOG_API_KEY;
if (!key) {
  console.error("SUPERLOG_API_KEY not set");
  process.exit(1);
}

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "superlog-proto-smoke" }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url,
        headers: { "x-api-key": key },
      }),
    ),
  ],
});

provider.register();

const tracer = trace.getTracer("superlog-proto-smoke");
const span = tracer.startSpan("proto-test-span");
span.setAttribute("test.marker", "e2e-proto");
span.end();

await provider.shutdown();
console.log("proto smoke sent");
