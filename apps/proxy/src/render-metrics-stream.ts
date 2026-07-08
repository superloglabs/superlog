// Render Metrics Stream (provider CUSTOM) → OTLP JSON stamped with
// telemetry.source=render. Render pushes standard OTLP/HTTP metrics to the
// endpoint the connector registered (/render/stream/metrics). Unlike our own
// transforms, the payload is produced by Render and carries no
// telemetry.source resource attribute — without stamping, streamed metrics
// would be indistinguishable from plain OTLP ingest on the read path.

type KeyValue = { key?: unknown; value?: unknown };

export function stampRenderStreamMetrics(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid Render metrics stream payload");
  }
  const root = payload as { resourceMetrics?: unknown };
  if (!Array.isArray(root.resourceMetrics)) {
    throw new Error("invalid Render metrics stream payload: missing resourceMetrics");
  }
  for (const rm of root.resourceMetrics) {
    if (!rm || typeof rm !== "object") continue;
    const entry = rm as {
      resource?: { attributes?: KeyValue[] };
      scopeMetrics?: unknown;
    };
    entry.resource ??= {};
    const attrs = Array.isArray(entry.resource.attributes) ? entry.resource.attributes : [];
    entry.resource.attributes = [
      ...attrs.filter((a) => !(a && typeof a === "object" && a.key === "telemetry.source")),
      { key: "telemetry.source", value: { stringValue: "render" } },
    ];
    stripExemplars(entry.scopeMetrics);
  }
  return payload;
}

// Protobuf-decoded exemplars carry trace/span ids as raw Buffers, which don't
// survive JSON re-encoding in the hex form OTLP JSON expects. They're
// irrelevant for infra metrics, so drop them rather than risk the collector
// rejecting the whole batch.
function stripExemplars(scopeMetrics: unknown): void {
  if (!Array.isArray(scopeMetrics)) return;
  for (const sm of scopeMetrics) {
    const metrics = (sm as { metrics?: unknown } | null)?.metrics;
    if (!Array.isArray(metrics)) continue;
    for (const metric of metrics) {
      if (!metric || typeof metric !== "object") continue;
      for (const family of ["gauge", "sum", "histogram", "exponentialHistogram", "summary"]) {
        const dataPoints = (metric as Record<string, { dataPoints?: unknown } | undefined>)[family]
          ?.dataPoints;
        if (!Array.isArray(dataPoints)) continue;
        for (const dp of dataPoints) {
          if (dp && typeof dp === "object" && "exemplars" in dp) {
            // undefined is omitted by JSON.stringify, which is all the
            // re-encode needs; assignment avoids the delete deopt.
            (dp as { exemplars?: unknown }).exemplars = undefined;
          }
        }
      }
    }
  }
}
