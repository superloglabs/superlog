import { credentials, Metadata } from "@grpc/grpc-js";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const url = process.env.OTLP_GRPC_URL ?? "http://localhost:4317";
const projectId = process.env.SUPERLOG_PROJECT_ID;
if (!projectId) {
  console.error("SUPERLOG_PROJECT_ID not set");
  process.exit(1);
}

const metadata = new Metadata();
metadata.set("x-superlog-project-id", projectId);

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "superlog-grpc-smoke" }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url,
        credentials: credentials.createInsecure(),
        metadata,
      }),
    ),
  ],
});

provider.register();

const tracer = trace.getTracer("superlog-grpc-smoke");
const span = tracer.startSpan("grpc-test-span");
span.setAttribute("test.marker", "e2e-grpc");
span.end();

await provider.shutdown();
console.log("grpc smoke sent");
