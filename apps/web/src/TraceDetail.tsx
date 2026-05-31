import { useEffect, useMemo, useState } from "react";
import { type TraceLog, type TraceSpan, useTraceDetail } from "./api.ts";
import { tracer } from "./instrumentation.ts";
import { Chip, Label } from "./design/ui.tsx";
import { formatLocalTimestampMs } from "./timeFormat.ts";

export function TraceDrawer({
  projectId,
  traceId,
  focusSpanId,
  onClose,
}: {
  projectId: string;
  traceId: string | null;
  focusSpanId?: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!traceId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [traceId, onClose]);

  if (!traceId) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--impersonation-h,0px)] z-50">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[1800px] flex-col border-l border-border bg-bg shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          title="close (esc)"
          className="absolute right-4 top-4 z-10 rounded-sm border border-border bg-bg px-2 py-1 font-mono text-[11px] text-muted hover:text-fg"
        >
          ✕
        </button>
        <TraceDrawerBody projectId={projectId} traceId={traceId} focusSpanId={focusSpanId} />
      </aside>
    </div>
  );
}

function TraceDrawerBody({
  projectId,
  traceId,
  focusSpanId,
}: {
  projectId: string;
  traceId: string;
  focusSpanId?: string | null;
}) {
  const detail = useTraceDetail(projectId, traceId);

  useEffect(() => {
    if (!detail.data) return;
    const span = tracer.startSpan("trace.render_detail", {
      attributes: {
        "trace.id": traceId,
        "trace.span_count": detail.data.spans.length,
        "trace.log_count": detail.data.logs?.length ?? 0,
      },
    });
    span.end();
  }, [detail.data, traceId]);

  useEffect(() => {
    if (!detail.error) return;
    const span = tracer.startSpan("trace.detail_error", {
      attributes: { "trace.id": traceId },
    });
    span.recordException(detail.error as Error);
    span.end();
  }, [detail.error, traceId]);

  if (detail.isLoading) {
    return <div className="flex-1 px-6 py-6 font-mono text-[11px] text-subtle">loading…</div>;
  }
  if (detail.error) {
    return (
      <div className="flex-1 px-6 py-6 font-mono text-[11px] text-danger">
        error: {String(detail.error)}
      </div>
    );
  }
  if (!detail.data || detail.data.spans.length === 0) {
    return (
      <div className="flex-1 px-6 py-6 font-mono text-[11px] text-subtle">
        no spans for this trace
      </div>
    );
  }

  return (
    <TraceContents
      key={traceId}
      traceId={traceId}
      spans={detail.data.spans}
      logs={detail.data.logs}
      focusSpanId={focusSpanId}
    />
  );
}

type SpanWithLayout = TraceSpan & {
  startNs: bigint;
  endNs: bigint;
  depth: number;
};

function buildLayout(spans: TraceSpan[]): {
  rows: SpanWithLayout[];
  traceStartNs: bigint;
  traceEndNs: bigint;
} {
  const byId = new Map<string, TraceSpan>();
  for (const s of spans) byId.set(s.span_id, s);

  let traceStartNs = BigInt(spans[0]!.start_ns);
  let traceEndNs = traceStartNs + BigInt(spans[0]!.duration_ns);
  for (const s of spans) {
    const start = BigInt(s.start_ns);
    const end = start + BigInt(s.duration_ns);
    if (start < traceStartNs) traceStartNs = start;
    if (end > traceEndNs) traceEndNs = end;
  }

  const depthCache = new Map<string, number>();
  function depthOf(s: TraceSpan, seen = new Set<string>()): number {
    const cached = depthCache.get(s.span_id);
    if (cached !== undefined) return cached;
    if (seen.has(s.span_id)) return 0;
    if (!s.parent_span_id) {
      depthCache.set(s.span_id, 0);
      return 0;
    }
    const parent = byId.get(s.parent_span_id);
    if (!parent) {
      depthCache.set(s.span_id, 0);
      return 0;
    }
    seen.add(s.span_id);
    const d = depthOf(parent, seen) + 1;
    depthCache.set(s.span_id, d);
    return d;
  }

  const rows: SpanWithLayout[] = spans.map((s) => ({
    ...s,
    startNs: BigInt(s.start_ns),
    endNs: BigInt(s.start_ns) + BigInt(s.duration_ns),
    depth: depthOf(s),
  }));

  rows.sort((a, b) => {
    if (a.startNs < b.startNs) return -1;
    if (a.startNs > b.startNs) return 1;
    return a.depth - b.depth;
  });

  return { rows, traceStartNs, traceEndNs };
}

function TraceContents({
  traceId,
  spans,
  logs,
  focusSpanId,
}: {
  traceId: string;
  spans: TraceSpan[];
  logs: TraceLog[];
  focusSpanId?: string | null;
}) {
  const { rows, traceStartNs, traceEndNs } = useMemo(() => buildLayout(spans), [spans]);
  const totalNs = traceEndNs - traceStartNs;

  const rootRow = rows.find((r) => r.depth === 0) ?? rows[0]!;

  const initialSpanId =
    focusSpanId && rows.some((r) => r.span_id === focusSpanId)
      ? focusSpanId
      : rootRow.span_id;
  type Selection =
    | { kind: "span"; spanId: string }
    | { kind: "log"; index: number };
  const [selection, setSelection] = useState<Selection>({
    kind: "span",
    spanId: initialSpanId,
  });
  useEffect(() => {
    if (focusSpanId && rows.some((r) => r.span_id === focusSpanId)) {
      setSelection({ kind: "span", spanId: focusSpanId });
    }
  }, [focusSpanId, rows]);

  const selectedSpan =
    selection.kind === "span"
      ? rows.find((r) => r.span_id === selection.spanId) ?? rootRow
      : rootRow;
  const selectedLog =
    selection.kind === "log" ? logs[selection.index] : undefined;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:divide-x lg:divide-border">
      <div className="flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto px-6 py-6">
        <section>
          <SectionHeader title="Trace" id={traceId} />
          <div className="border border-border">
            <SpanWaterfall
              rows={rows}
              traceStartNs={traceStartNs}
              totalNs={totalNs}
              selectedSpanId={
                selection.kind === "span" ? selection.spanId : null
              }
              onSelect={(spanId) => setSelection({ kind: "span", spanId })}
            />
          </div>
        </section>

        <section>
          <div className="mb-2">
            <Label>logs ({logs.length})</Label>
          </div>
          <div className="border border-border">
            <LogsForTrace
              logs={logs}
              selectedIndex={
                selection.kind === "log" ? selection.index : null
              }
              onSelect={(index) => setSelection({ kind: "log", index })}
            />
          </div>
        </section>
      </div>

      <aside className="min-h-0 min-w-0 overflow-y-auto px-6 py-6">
        {selectedLog ? (
          <>
            <SectionHeader
              title="Log"
              id={formatLocalTimestampMs(selectedLog.timestamp)}
            />
            <div className="border border-border">
              <LogAttributesPanel log={selectedLog} />
            </div>
          </>
        ) : (
          <>
            <SectionHeader title="Span" id={selectedSpan.span_id} />
            <div className="border border-border">
              <SpanAttributesPanel span={selectedSpan} />
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function SpanWaterfall({
  rows,
  traceStartNs,
  totalNs,
  selectedSpanId,
  onSelect,
}: {
  rows: SpanWithLayout[];
  traceStartNs: bigint;
  totalNs: bigint;
  selectedSpanId: string | null;
  onSelect: (id: string) => void;
}) {
  const totalNsNum = Number(totalNs);
  const totalMs = totalNsNum / 1_000_000;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    pct: f * 100,
    ms: f * totalMs,
  }));

  return (
    <div className="font-mono text-[11px]">
      <div className="grid grid-cols-[minmax(180px,1fr)_2fr_72px] items-center gap-3 border-b border-border px-4 py-1.5 text-subtle">
        <div className="text-[10px] uppercase tracking-[0.2em]">span</div>
        <div />
        <div className="text-right text-[10px] uppercase tracking-[0.2em]">duration</div>
      </div>
      {rows.map((s, i) => {
        const offsetNs = Number(s.startNs - traceStartNs);
        const durationNs = Number(s.endNs - s.startNs);
        const leftPct = totalNsNum > 0 ? (offsetNs / totalNsNum) * 100 : 0;
        const widthPct = totalNsNum > 0 ? (durationNs / totalNsNum) * 100 : 100;
        const isError = s.status_code === "STATUS_CODE_ERROR";
        const offsetMs = offsetNs / 1_000_000;
        const durationMs = durationNs / 1_000_000;
        const durationLabel =
          durationMs < 0.01 ? "<0.01" : durationMs < 1 ? durationMs.toFixed(2) : durationMs.toFixed(2);
        const isSelected = s.span_id === selectedSpanId;
        return (
          <button
            type="button"
            key={s.span_id}
            onClick={() => onSelect(s.span_id)}
            className={`grid w-full grid-cols-[minmax(180px,1fr)_2fr_72px] items-center gap-3 px-4 py-1.5 text-left hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2 ${
              isSelected ? "bg-accent/10 ring-1 ring-inset ring-accent" : ""
            } ${i > 0 ? "border-t border-border" : ""}`}
          >
            <div className="flex items-center gap-2 truncate">
              <span style={{ width: `${s.depth * 12}px` }} className="shrink-0" />
              <span className="truncate" title={`${s.service} · ${s.span_name}`}>
                <span className="text-fg">{s.span_name}</span>
                <span className="ml-2 text-subtle">{s.service}</span>
              </span>
              {isError && <Chip tone="danger">err</Chip>}
            </div>
            <div className="relative h-4">
              <div className="absolute inset-y-0 left-0 right-0 bg-surface-2" />
              {ticks.slice(1, -1).map((t) => (
                <div
                  key={t.pct}
                  className="absolute inset-y-0 w-px bg-border"
                  style={{ left: `${t.pct}%` }}
                />
              ))}
              <div
                className={`absolute inset-y-0 ${isError ? "bg-danger" : "bg-accent"}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: "2px" }}
                title={`+${offsetMs.toFixed(2)}ms · ${durationMs.toFixed(2)}ms`}
              />
            </div>
            <div className="text-right tabular-nums text-muted">
              {durationLabel}ms
            </div>
          </button>
        );
      })}
      <div className="grid grid-cols-[minmax(180px,1fr)_2fr_72px] items-center gap-3 border-t border-border px-4 py-1.5">
        <div />
        <div className="relative h-4">
          {ticks.map((t) => (
            <div
              key={t.pct}
              className={`absolute top-0 text-[10px] tabular-nums text-subtle ${
                t.pct === 0
                  ? ""
                  : t.pct === 100
                    ? "-translate-x-full"
                    : "-translate-x-1/2"
              }`}
              style={{ left: `${t.pct}%` }}
            >
              {t.ms < 1 ? `${t.ms.toFixed(2)}ms` : `${t.ms.toFixed(t.ms < 10 ? 2 : 1)}ms`}
            </div>
          ))}
        </div>
        <div />
      </div>
    </div>
  );
}

function LogsForTrace({
  logs,
  selectedIndex,
  onSelect,
}: {
  logs: TraceLog[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}) {
  if (logs.length === 0) {
    return (
      <div className="px-4 py-6 text-center font-mono text-[11px] text-subtle">
        no logs for this trace
      </div>
    );
  }
  return (
    <table className="w-full border-collapse font-mono text-[11.5px]">
      <thead>
        <tr className="text-left text-subtle">
          <th className="px-4 py-2 font-normal">timestamp</th>
          <th className="px-4 py-2 font-normal">service</th>
          <th className="px-4 py-2 font-normal">sev</th>
          <th className="px-4 py-2 font-normal">span</th>
          <th className="px-4 py-2 font-normal">body</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((l, i) => {
          const isSelected = i === selectedIndex;
          return (
            <tr
              key={i}
              onClick={() => onSelect(i)}
              className={`cursor-pointer border-t border-border align-top hover:bg-surface-2 ${
                isSelected ? "bg-accent/10 outline outline-1 -outline-offset-1 outline-accent" : ""
              }`}
            >
              <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted">
                {formatLocalTimestampMs(l.timestamp)}
              </td>
              <td className="whitespace-nowrap px-4 py-2 text-fg">{l.service}</td>
              <td className="whitespace-nowrap px-4 py-2">
                <SeverityChip severity={l.severity} />
              </td>
              <td className="whitespace-nowrap px-4 py-2 text-subtle">
                {l.span_id ? l.span_id.slice(0, 8) : "—"}
              </td>
              <td className="px-4 py-2 text-muted">
                <span className="line-clamp-2 break-all">{l.body}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SectionHeader({ title, id }: { title: string; id: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h2 className="text-sm font-medium text-fg">{title}</h2>
      <span
        className="min-w-0 truncate font-mono text-[11px] text-subtle"
        title={id}
      >
        {id}
      </span>
    </div>
  );
}

function SpanAttributesPanel({ span }: { span: SpanWithLayout }) {
  const spanAttrs = span.span_attrs ?? {};
  const resourceAttrs = span.resource_attrs ?? {};
  const durationMs = Number(span.endNs - span.startNs) / 1_000_000;
  const meta: Array<[string, string]> = [
    ["span_name", span.span_name],
    ["service", span.service],
    ["kind", span.span_kind || "—"],
    ["status", span.status_code || "—"],
    ...(span.status_message ? ([["status_message", span.status_message]] as Array<[string, string]>) : []),
    ["duration", `${durationMs.toFixed(2)} ms`],
    ["span_id", span.span_id],
    ...(span.parent_span_id ? ([["parent_span_id", span.parent_span_id]] as Array<[string, string]>) : []),
  ];

  return (
    <div className="flex flex-col font-mono text-[11.5px]">
      <AttrSection title="metadata" entries={meta} />
      <AttrSection
        title={`span attributes (${Object.keys(spanAttrs).length})`}
        entries={sortedEntries(spanAttrs)}
      />
      <AttrSection
        title={`resource attributes (${Object.keys(resourceAttrs).length})`}
        entries={sortedEntries(resourceAttrs)}
      />
    </div>
  );
}

function LogAttributesPanel({ log }: { log: TraceLog }) {
  const logAttrs = log.log_attrs ?? {};
  const meta: Array<[string, string]> = [
    ["timestamp", formatLocalTimestampMs(log.timestamp)],
    ["severity", log.severity || "—"],
    ["service", log.service || "—"],
    ["span_id", log.span_id || "—"],
    ["trace_id", log.trace_id],
  ];
  const parsedBody = tryParseJson(log.body);
  const bodyText =
    parsedBody !== undefined ? JSON.stringify(parsedBody, null, 2) : log.body;

  return (
    <div className="flex flex-col font-mono text-[11.5px]">
      <AttrSection title="metadata" entries={meta} />
      <section className="border-b border-border last:border-b-0">
        <div className="border-b border-border bg-surface-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-subtle">
          body
        </div>
        {bodyText ? (
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-fg">
            {bodyText}
          </pre>
        ) : (
          <div className="px-3 py-2 text-subtle">—</div>
        )}
      </section>
      <AttrSection
        title={`log attributes (${Object.keys(logAttrs).length})`}
        entries={sortedEntries(logAttrs)}
      />
    </div>
  );
}

function tryParseJson(s: string): unknown | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function sortedEntries(obj: Record<string, string>): Array<[string, string]> {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}

function AttrSection({
  title,
  entries,
}: {
  title: string;
  entries: Array<[string, string]>;
}) {
  return (
    <section className="border-b border-border last:border-b-0">
      <div className="border-b border-border bg-surface-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-subtle">
        {title}
      </div>
      {entries.length === 0 ? (
        <div className="px-3 py-2 text-subtle">none</div>
      ) : (
        <dl className="divide-y divide-border">
          {entries.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 px-3 py-1.5">
              <dt className="truncate text-subtle" title={k}>
                {k}
              </dt>
              <dd className="break-all text-fg" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function SeverityChip({ severity }: { severity: string }) {
  const s = (severity || "").toUpperCase();
  const cls = !s
    ? "bg-muted/15 text-muted"
    : s.includes("ERROR") || s.includes("FATAL")
      ? "bg-danger/15 text-danger"
      : s.includes("WARN")
        ? "bg-warning/15 text-warning"
        : s.includes("DEBUG") || s.includes("TRACE")
          ? "bg-muted/15 text-muted"
          : "bg-success/15 text-success";
  return (
    <span
      className={`inline-flex items-center rounded-sm px-2 py-0.5 font-mono text-[11px] tabular-nums ${cls}`}
    >
      {s || "—"}
    </span>
  );
}
