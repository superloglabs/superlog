import { createClient } from "@clickhouse/client";
import { logger } from "../../logger.js";
import { getClickhouseConfig } from "./config.js";

const ch = createClient(getClickhouseConfig());

type TraceSpanRow = {
  timestamp: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  span_name: string;
  span_kind: string;
  status_code: string;
  status_message: string;
  duration_ns: string;
  span_attrs: Record<string, string>;
  resource_attrs: Record<string, string>;
  event_names: string[];
  event_attrs: Array<Record<string, string>>;
};

const TRACE_CONTEXT_SPAN_LIMIT = 80;
const TRACE_CONTEXT_CHAR_LIMIT = 14_000;

// Attribute keys that are useful for agentRun prompts. Order matters for output.
const SPAN_ATTR_KEYS = [
  "http.method",
  "http.request.method",
  "http.route",
  "http.target",
  "url.path",
  "http.status_code",
  "http.response.status_code",
  "error.type",
  "phoenix.action",
  "phoenix.plug",
  "graphql.operation.name",
  "graphql.operation.type",
  "graphql.field.name",
  "db.system",
  "db.name",
  "db.operation",
  "db.statement",
  "db.sql.table",
  "source",
  "code.namespace",
  "code.function",
  "code.filepath",
  "messaging.system",
  "messaging.destination.name",
  "rpc.service",
  "rpc.method",
];
const RESOURCE_ATTR_KEYS = ["service.name", "service.version", "deployment.environment"];

function spanKindLabel(kind: string): string {
  // OTel SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER.
  // ClickHouse can return either the int or the enum-string form.
  const map: Record<string, string> = {
    "0": "unspec",
    "1": "internal",
    "2": "server",
    "3": "client",
    "4": "producer",
    "5": "consumer",
    SPAN_KIND_UNSPECIFIED: "unspec",
    SPAN_KIND_INTERNAL: "internal",
    SPAN_KIND_SERVER: "server",
    SPAN_KIND_CLIENT: "client",
    SPAN_KIND_PRODUCER: "producer",
    SPAN_KIND_CONSUMER: "consumer",
    Internal: "internal",
    Server: "server",
    Client: "client",
    Producer: "producer",
    Consumer: "consumer",
  };
  return map[kind] ?? kind.toLowerCase();
}

function formatAttrLine(
  prefix: string,
  source: Record<string, string>,
  keys: string[],
): string | null {
  const parts: string[] = [];
  for (const key of keys) {
    const v = source[key];
    if (v === undefined || v === null || v === "") continue;
    const truncated = v.length > 240 ? `${v.slice(0, 240)}…` : v;
    parts.push(`${key}=${truncated}`);
  }
  return parts.length === 0 ? null : `  ${prefix}: ${parts.join(", ")}`;
}

function findRoot(rows: TraceSpanRow[]): TraceSpanRow | null {
  if (rows.length === 0) return null;
  const byId = new Map(rows.map((r) => [r.span_id, r]));
  for (const r of rows) {
    if (!r.parent_span_id || !byId.has(r.parent_span_id)) return r;
  }
  return rows[0] ?? null;
}

function formatTraceContext(
  traceId: string,
  rows: TraceSpanRow[],
  anchorSpanId: string | null,
): string {
  // Reorder so the anchor span (if present) is rendered first, then the root, then chronological order.
  const seen = new Set<string>();
  const ordered: TraceSpanRow[] = [];
  const push = (row: TraceSpanRow | null | undefined) => {
    if (!row || seen.has(row.span_id)) return;
    seen.add(row.span_id);
    ordered.push(row);
  };
  const byId = new Map(rows.map((r) => [r.span_id, r]));
  const anchor = anchorSpanId ? (byId.get(anchorSpanId) ?? null) : null;
  push(anchor);
  push(findRoot(rows));
  for (const r of rows) push(r);

  const capped = ordered.slice(0, TRACE_CONTEXT_SPAN_LIMIT);
  const out: string[] = [];
  out.push(`Trace ${traceId} (${rows.length} spans, showing ${capped.length}):`);

  for (const r of capped) {
    const kind = spanKindLabel(r.span_kind);
    const durMs = Number(r.duration_ns || "0") / 1_000_000;
    const status =
      r.status_code && r.status_code !== "STATUS_CODE_UNSET" && r.status_code !== "0"
        ? r.status_code
        : "";
    const marker = anchorSpanId && r.span_id === anchorSpanId ? " [FAILING SPAN]" : "";
    const headerParts = [
      `[${kind}]`,
      r.service || "?",
      r.span_name || "?",
      `span=${r.span_id}`,
      r.parent_span_id ? `parent=${r.parent_span_id}` : "parent=-",
      `dur=${durMs.toFixed(1)}ms`,
    ];
    if (status)
      headerParts.push(`status=${status}${r.status_message ? `(${r.status_message})` : ""}`);
    out.push(headerParts.join(" ") + marker);

    const attrs = formatAttrLine("attrs", r.span_attrs ?? {}, SPAN_ATTR_KEYS);
    if (attrs) out.push(attrs);
    const resource = formatAttrLine("resource", r.resource_attrs ?? {}, RESOURCE_ATTR_KEYS);
    if (resource) out.push(resource);

    const events = r.event_names ?? [];
    const eventAttrs = r.event_attrs ?? [];
    for (let i = 0; i < events.length; i++) {
      const name = events[i];
      const a = eventAttrs[i] ?? {};
      if (name === "exception") {
        const type = a["exception.type"] ?? "";
        const msg = a["exception.message"] ?? "";
        const stack = a["exception.stacktrace"] ?? "";
        out.push(`  event: exception type=${type}${msg ? ` message=${msg.slice(0, 200)}` : ""}`);
        if (stack && anchorSpanId && r.span_id === anchorSpanId) {
          const trimmed =
            stack.length > 4_000 ? `${stack.slice(0, 4_000)}\n…[stacktrace truncated]` : stack;
          out.push(
            `  stacktrace: |\n${trimmed
              .split("\n")
              .map((line) => `    ${line}`)
              .join("\n")}`,
          );
        }
      } else if (name) {
        out.push(`  event: ${name}`);
      }
    }
  }

  let joined = out.join("\n");
  if (joined.length > TRACE_CONTEXT_CHAR_LIMIT) {
    joined = `${joined.slice(0, TRACE_CONTEXT_CHAR_LIMIT)}\n…[trace context truncated]`;
  }
  return joined;
}

// Time bounds for the span lookup. TraceId alone can't be found efficiently:
// otel_traces is sorted by (ServiceName, SpanName, Timestamp) and partitioned
// by day, so an unbounded TraceId query probes the bloom index across every
// partition in retention (~20s+ on a large deployment, and it saturates the
// read pool under concurrency). A time bound restores partition pruning. The
// caller passes the event timestamp the trace id came from (issue sample
// seenAt / issue lastSeen) — spans of that trace lie within ±1h of it. With
// no usable hint, bound to the last 72h: investigations are about recent
// events, and an unbounded scan is never worth its cost.
const HINT_MARGIN_MS = 60 * 60 * 1000;
const NO_HINT_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const NO_HINT_HEADROOM_MS = 5 * 60 * 1000;

export function traceContextTimeBounds(
  hintTs: Date | null,
  now: Date,
): { fromMs: number; toMs: number } {
  if (hintTs && Number.isFinite(hintTs.getTime())) {
    return { fromMs: hintTs.getTime() - HINT_MARGIN_MS, toMs: hintTs.getTime() + HINT_MARGIN_MS };
  }
  return { fromMs: now.getTime() - NO_HINT_LOOKBACK_MS, toMs: now.getTime() + NO_HINT_HEADROOM_MS };
}

export async function fetchTraceContext(
  projectId: string,
  traceId: string,
  anchorSpanId: string | null,
  hintTs: Date | null = null,
): Promise<string | null> {
  if (!traceId) return null;
  const { fromMs, toMs } = traceContextTimeBounds(hintTs, new Date());
  try {
    const result = await ch.query({
      query: `
        SELECT
          toString(Timestamp) AS timestamp,
          SpanId AS span_id,
          ParentSpanId AS parent_span_id,
          ServiceName AS service,
          SpanName AS span_name,
          toString(SpanKind) AS span_kind,
          toString(StatusCode) AS status_code,
          StatusMessage AS status_message,
          toString(Duration) AS duration_ns,
          SpanAttributes AS span_attrs,
          ResourceAttributes AS resource_attrs,
          Events.Name AS event_names,
          Events.Attributes AS event_attrs
        FROM otel_traces
        WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
          AND TraceId = {traceId:String}
          AND Timestamp >= fromUnixTimestamp64Milli({fromMs:Int64})
          AND Timestamp <= fromUnixTimestamp64Milli({toMs:Int64})
        ORDER BY Timestamp ASC, SpanId ASC
        LIMIT 200
      `,
      query_params: { projectId, traceId, fromMs, toMs },
      format: "JSONEachRow",
      // Fail fast instead of holding an agent-run advance slot until the
      // socket timeout — the prompt degrades gracefully without trace context.
      clickhouse_settings: { max_execution_time: 10 },
    });
    const rows = (await result.json()) as TraceSpanRow[];
    if (rows.length === 0) return null;
    return formatTraceContext(traceId, rows, anchorSpanId);
  } catch (err) {
    logger.warn({ err: (err as Error).message, projectId, traceId }, "trace context fetch failed");
    return null;
  }
}
