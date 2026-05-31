import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("@superlog/sample");

export async function GET() {
  return tracer.startActiveSpan("healthcheck.serve", async (span) => {
    try {
      span.setAttribute("healthcheck.kind", "ok");
      const body = { ok: true };
      span.setStatus({ code: SpanStatusCode.OK });
      return Response.json(body);
    } finally {
      span.end();
    }
  });
}
