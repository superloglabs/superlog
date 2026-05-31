import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("@superlog/sample");

export async function GET() {
  return tracer.startActiveSpan("demo.fail", (span) => {
    span.setAttribute("demo.kind", "thrown-error");
    const err = new Error("sample: deliberately broken endpoint");
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.end();
    throw err;
  });
}
