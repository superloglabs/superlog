import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("@superlog/sample");

export async function GET() {
  return tracer.startActiveSpan("demo.null-deref", (span) => {
    span.setAttribute("demo.kind", "null-deref");
    try {
      const obj = null as unknown as { name: string };
      const body = { name: obj.name };
      span.setStatus({ code: SpanStatusCode.OK });
      return Response.json(body);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
