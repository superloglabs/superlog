import { type ReactNode, useState } from "react";
import type { IncidentEvent } from "../api.ts";
import { CountChart } from "../dashboards/widgets/CountChart.tsx";
import { DEFAULT_TOP_N } from "../dashboards/widgets/series-topn.ts";
import { Chip, type ChipTone } from "../design/ui.tsx";
import { LogsTable, TracesTable } from "../Explore.tsx";
import {
  type TelemetryKind,
  exploreHref,
  formatRangeLabel,
  parseResultRows,
  telemetryToolKind,
  toLogRows,
  toMetricRows,
  toTraceRows,
} from "./telemetry-result.ts";

// ---------------------------------------------------------------------------
// IncidentTranscript — renders an agent run's conversation from incident_events:
// messages, telemetry queries as live widgets (charts/tables built from the
// agent's recorded result), and code tool-calls / edits. Lifecycle events stay
// in the timeline; this is only the agent.* conversation.
// ---------------------------------------------------------------------------

type ToolUseDetail = { name?: string; input?: Record<string, unknown>; mcpServerName?: string };
type ToolResultDetail = { toolUseId?: string; isError?: boolean };

function readToolUse(e: IncidentEvent): ToolUseDetail | null {
  const d = e.detail as { toolUse?: ToolUseDetail } | null;
  return d?.toolUse ?? null;
}
function readToolResult(e: IncidentEvent): ToolResultDetail | null {
  const d = e.detail as { toolResult?: ToolResultDetail } | null;
  return d?.toolResult ?? null;
}

type TranscriptItem =
  | { type: "message"; id: string; text: string }
  | {
      type: "telemetry";
      id: string;
      kind: TelemetryKind;
      input: Record<string, unknown>;
      rows: Record<string, unknown>[];
      isError: boolean;
    }
  | {
      type: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      result: string | null;
      isError: boolean;
    };

type FeedItem = TranscriptItem | { type: "lifecycle"; id: string; event: IncidentEvent };

const TOOL_USE_KINDS = new Set(["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"]);
const TOOL_RESULT_KINDS = new Set([
  "agent.tool_result",
  "agent.mcp_tool_result",
  "user.custom_tool_result",
]);

// Provider heartbeats that carry no narrative: model-request spans and
// session/thread status flips. `session.error` is kept — it explains failures.
function isFeedNoise(kind: string): boolean {
  if (kind === "session.error") return false;
  return kind.startsWith("span.") || kind.startsWith("session.");
}

// The full activity feed: the agent's conversation (messages, telemetry
// queries, tool calls) interleaved in event order with lifecycle / external
// events (run started, status changes, PR & Linear activity).
export function buildActivityFeed(events: IncidentEvent[]): FeedItem[] {
  // Pair each result to its use by the provider tool-use id.
  const resultByUseId = new Map<string, IncidentEvent>();
  for (const e of events) {
    if (TOOL_RESULT_KINDS.has(e.kind)) {
      const id = readToolResult(e)?.toolUseId;
      if (id) resultByUseId.set(id, e);
    }
  }

  const items: FeedItem[] = [];
  for (const e of events) {
    if (e.kind === "agent.message") {
      const text = (e.summary ?? "").trim();
      if (text) items.push({ type: "message", id: e.id, text });
      continue;
    }
    if (TOOL_USE_KINDS.has(e.kind)) {
      const use = readToolUse(e);
      const name = use?.name ?? "tool";
      const result = resultByUseId.get(e.providerEventId ?? e.id) ?? null;
      const isError = result ? (readToolResult(result)?.isError ?? false) : false;
      const kind = telemetryToolKind(name);
      if (kind) {
        items.push({
          type: "telemetry",
          id: e.id,
          kind,
          input: use?.input ?? {},
          rows: parseResultRows(result?.summary),
          isError,
        });
      } else if (name !== "submit_agent_run_result") {
        items.push({
          type: "tool",
          id: e.id,
          name,
          input: use?.input ?? {},
          result: result?.summary ?? null,
          isError,
        });
      }
      continue;
    }
    // agent.thinking is a content-free heartbeat; tool results are consumed above.
    if (e.kind === "agent.thinking" || TOOL_RESULT_KINDS.has(e.kind)) continue;
    if (e.kind.startsWith("agent.") || isFeedNoise(e.kind)) continue;
    items.push({ type: "lifecycle", id: e.id, event: e });
  }
  return items;
}

// Conversation-only projection, used where lifecycle events live elsewhere
// (the drawer's separate timeline, summary-cited telemetry).
export function buildTranscript(events: IncidentEvent[]): TranscriptItem[] {
  return buildActivityFeed(events).filter(
    (item): item is TranscriptItem => item.type !== "lifecycle",
  );
}

// The incident detail's main feed: transcript + lifecycle events on one rail,
// in chronological order.
export function IncidentActivityFeed({
  events,
  renderIssueCard,
}: {
  events: IncidentEvent[];
  /** Renders the referenced issue as a card under lifecycle events whose
   *  detail carries an `issueId` (recurrence, reopen). */
  renderIssueCard?: (issueId: string) => ReactNode;
}) {
  const items = buildActivityFeed(events);
  if (items.length === 0) return null;
  return (
    <div className="relative pl-7">
      {/* Start at the first entry's marker center (~12px) so no line pokes above it. */}
      <div className="absolute bottom-2 left-[10px] top-3 w-px bg-border" />
      {items.map((item) => {
        if (item.type === "message") return <MessageEntry key={item.id} text={item.text} />;
        if (item.type === "telemetry") return <TelemetryEntry key={item.id} item={item} />;
        if (item.type === "tool") return <ToolEntry key={item.id} item={item} />;
        return (
          <LifecycleEntry key={item.id} event={item.event} renderIssueCard={renderIssueCard} />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trail scaffolding
// ---------------------------------------------------------------------------

function Node({ tone = "muted", children }: { tone?: "accent" | "muted"; children: ReactNode }) {
  return (
    <span
      className={`absolute -left-7 top-0.5 grid h-[22px] w-[22px] place-items-center rounded-full border bg-surface-2 ${
        tone === "accent" ? "border-accent/40" : "border-border"
      }`}
    >
      <svg
        className={`h-3 w-3 ${tone === "accent" ? "text-[#97a3f2]" : "text-muted"}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );
}

function MessageEntry({ text }: { text: string }) {
  return (
    <div className="relative mb-6">
      <Node tone="accent">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-4-1L3 20l1.1-3.3A8.4 8.4 0 1 1 21 11.5z" />
      </Node>
      <div className="mb-1.5 text-[12px] font-semibold text-fg">Investigation agent</div>
      <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg/85">{text}</div>
    </div>
  );
}

// Lifecycle / external events (run started, incident status changes, PR and
// Linear activity) rendered as compact one-liners on the same rail so the
// conversation keeps its chronology.
function LifecycleEntry({
  event,
  renderIssueCard,
}: {
  event: IncidentEvent;
  renderIssueCard?: (issueId: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = (event.summary ?? "").trim() || humanizeEventKind(event.kind);
  const firstLine = summary.split("\n", 1)[0] ?? "";
  const truncatable = summary.length > firstLine.length || firstLine.length > 160;
  const detail = event.detail ?? {};
  const detailUrl =
    (typeof detail.html_url === "string" && detail.html_url) ||
    (typeof detail.prUrl === "string" && detail.prUrl) ||
    (typeof detail.ticketUrl === "string" && detail.ticketUrl) ||
    null;
  const actor = event.actor;
  const issueId = typeof detail.issueId === "string" ? detail.issueId : null;
  const issueCard = issueId && renderIssueCard ? renderIssueCard(issueId) : null;

  return (
    <div className="relative mb-5">
      <span className="absolute -left-7 top-0.5 grid h-[22px] w-[22px] place-items-center">
        {actor?.avatarUrl ? (
          <img src={actor.avatarUrl} alt={actor.name ?? ""} className="h-4 w-4 rounded-full" />
        ) : (
          <span className="h-2 w-2 rounded-full border-2 border-border-strong bg-bg" />
        )}
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] leading-relaxed">
        {actor?.name &&
          (actor.profileUrl ? (
            <a
              href={actor.profileUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-fg hover:underline"
            >
              {actor.name}
            </a>
          ) : (
            <span className="font-medium text-fg">{actor.name}</span>
          ))}
        {!expanded && <span className="min-w-0 flex-1 truncate text-muted">{firstLine}</span>}
        {detailUrl && (
          <a
            href={detailUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[11px] text-subtle hover:text-fg hover:underline"
          >
            view
          </a>
        )}
        <span className="shrink-0 whitespace-nowrap text-[11px] text-subtle">
          {fmtRelative(event.createdAt)}
        </span>
        {truncatable && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 text-[11px] text-subtle hover:text-fg"
          >
            {expanded ? "show less" : "show more"}
          </button>
        )}
      </div>
      {expanded && (
        <pre className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted">
          {summary}
        </pre>
      )}
      {issueCard && <div className="mt-2">{issueCard}</div>}
    </div>
  );
}

function humanizeEventKind(kind: string): string {
  const cleaned = kind.replace(/[._]/g, " ").trim().toLowerCase();
  if (!cleaned) return kind;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const TELEMETRY_LABEL: Record<TelemetryKind, string> = {
  metrics: "Queried metrics",
  logs: "Queried logs",
  traces: "Queried traces",
};

function TelemetryEntry({
  item,
}: {
  item: Extract<TranscriptItem, { type: "telemetry" }>;
}) {
  return (
    <div className="relative mb-6">
      <Node tone="accent">
        {item.kind === "metrics" ? (
          <>
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
          </>
        ) : item.kind === "traces" ? (
          <>
            <path d="M3 3v18h18" />
            <path d="m7 14 4-4 3 3 5-6" />
          </>
        ) : (
          <path d="M4 5h16M4 12h16M4 19h10" />
        )}
      </Node>
      <div className="mb-1.5 text-[12px] font-semibold text-fg">{TELEMETRY_LABEL[item.kind]}</div>
      <TelemetryQueryWidget
        kind={item.kind}
        input={item.input}
        rows={item.rows}
        isError={item.isError}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TelemetryQueryWidget — renders the agent's recorded query result as a widget.
// ---------------------------------------------------------------------------

const QUERY_FN: Record<TelemetryKind, string> = {
  metrics: "query_metrics",
  logs: "query_logs",
  traces: "query_traces",
};

function filterChips(input: Record<string, unknown>): { label: string; tone: ChipTone }[] {
  const chips: { label: string; tone: ChipTone }[] = [];
  const push = (label: string, tone: ChipTone = "muted") => chips.push({ label, tone });
  if (typeof input.metric_name === "string") push(input.metric_name);
  if (typeof input.service === "string") push(`service = ${input.service}`);
  if (typeof input.span_name === "string") push(`span = ${input.span_name}`);
  if (typeof input.severity === "string") push(`severity = ${input.severity}`, "danger");
  if (typeof input.search === "string") push(`“${input.search}”`);
  if (typeof input.status_code === "string") push(input.status_code);
  for (const key of ["resource_attrs", "span_attrs", "log_attrs"] as const) {
    const attrs = input[key];
    if (Array.isArray(attrs)) {
      for (const a of attrs as { key?: string; value?: string }[]) {
        if (a && typeof a.key === "string") push(`${a.key} = ${a.value ?? ""}`);
      }
    }
  }
  return chips.slice(0, 5);
}

export function TelemetryQueryWidget({
  kind,
  input,
  rows,
  isError,
}: {
  kind: TelemetryKind;
  input: Record<string, unknown>;
  rows: Record<string, unknown>[];
  isError?: boolean;
}) {
  const range = (input.range as { since?: string; until?: string } | undefined) ?? undefined;
  const windowLabel = formatRangeLabel(range);
  const count = rows.length;
  const empty = count === 0;

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2">
        <span className="font-mono text-[11.5px] text-[#97a3f2]">{QUERY_FN[kind]}</span>
        <span className="text-subtle">·</span>
        {filterChips(input).map((f, i) => (
          <Chip key={`${f.label}-${i}`} tone={f.tone}>
            {f.label}
          </Chip>
        ))}
      </div>

      <div className="px-3.5 py-3">
        {isError ? (
          <div className="py-6 text-center font-mono text-[11px] text-danger">query failed</div>
        ) : empty ? (
          <div className="py-6 text-center font-mono text-[11px] text-subtle">
            no rows in this window
          </div>
        ) : kind === "metrics" ? (
          <MetricWidget
            rows={rows}
            range={range}
            metricName={String(input.metric_name ?? "value")}
          />
        ) : kind === "logs" ? (
          <div className="overflow-x-auto">
            <LogsTable rows={toLogRows(rows)} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <TracesTable rows={toTraceRows(rows)} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3.5 py-2 text-[11.5px] text-muted">
        <svg
          className="h-3 w-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        {windowLabel ? (
          <>
            window <span className="font-mono text-fg">{windowLabel}</span>
          </>
        ) : (
          <span className="font-mono">recorded result</span>
        )}
        {!empty && <span className="text-subtle">· {count} rows</span>}
        <a
          href={exploreHref(kind, input)}
          className="ml-auto inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-surface-2"
        >
          Open in Explore
        </a>
      </div>
    </div>
  );
}

function isoRange(
  range: { since?: string; until?: string } | undefined,
): { since: string; until: string } | undefined {
  if (!range?.since || !range?.until) return undefined;
  const iso = (s: string) =>
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && Number.isFinite(Date.parse(s));
  return iso(range.since) && iso(range.until)
    ? { since: range.since, until: range.until }
    : undefined;
}

function MetricWidget({
  rows,
  range,
  metricName,
}: {
  rows: Record<string, unknown>[];
  range: { since?: string; until?: string } | undefined;
  metricName: string;
}) {
  const series = toMetricRows(rows, metricName);
  if (series.length === 0) {
    return <div className="py-6 text-center font-mono text-[11px] text-subtle">no points</div>;
  }
  return (
    <div style={{ height: 150 }}>
      <CountChart
        rows={series}
        value={(r) => r.value}
        range={isoRange(range)}
        chartType="line"
        limit={DEFAULT_TOP_N}
        showXAxis
        showYAxis
        showLegend={false}
        legendPosition="side"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code / integration tool calls — compact, with an inline diff for edits.
// ---------------------------------------------------------------------------

const EDIT_TOOLS = new Set(["edit", "write", "multi_edit", "str_replace_editor"]);

function ToolEntry({ item }: { item: Extract<TranscriptItem, { type: "tool" }> }) {
  const isEdit = EDIT_TOOLS.has(item.name);
  return (
    <div className="relative mb-6">
      <Node>
        {isEdit ? (
          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        ) : (
          <>
            <path d="m8 6-6 6 6 6" />
            <path d="m16 6 6 6-6 6" />
          </>
        )}
      </Node>
      {isEdit ? <EditEntry item={item} /> : <CodeEntry item={item} />}
    </div>
  );
}

function toolArg(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === "string") return input[k] as string;
    return "";
  };
  return first("command", "pattern", "query", "file_path", "path", "metric_name") || name;
}

function CodeEntry({ item }: { item: Extract<TranscriptItem, { type: "tool" }> }) {
  const result = (item.result ?? "").trim();
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-muted">{item.name}</span>
        <span className="truncate text-fg">{toolArg(item.name, item.input)}</span>
      </div>
      {result && (
        <div
          className={`mt-1 line-clamp-2 break-all ${item.isError ? "text-danger" : "text-subtle"}`}
        >
          {result.slice(0, 240)}
        </div>
      )}
    </div>
  );
}

function EditEntry({ item }: { item: Extract<TranscriptItem, { type: "tool" }> }) {
  const file = typeof item.input.file_path === "string" ? item.input.file_path : item.name;
  const oldStr = typeof item.input.old_string === "string" ? item.input.old_string : "";
  const newStr =
    typeof item.input.new_string === "string"
      ? item.input.new_string
      : typeof item.input.content === "string"
        ? item.input.content
        : "";
  const lines: { t: "add" | "del"; text: string }[] = [
    ...(oldStr ? oldStr.split("\n").map((text) => ({ t: "del" as const, text })) : []),
    ...(newStr ? newStr.split("\n").map((text) => ({ t: "add" as const, text })) : []),
  ].slice(0, 18);
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-semibold text-fg">
        Edited <span className="font-mono font-normal text-muted">{file}</span>
      </div>
      {lines.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed">
            {lines.map((l, i) => (
              <div key={i} className={l.t === "add" ? "text-success" : "text-danger"}>
                <span className="select-none opacity-60">{l.t === "add" ? "+ " : "- "}</span>
                {l.text || " "}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary-cited telemetry: the chart-able metric query the agent ran, surfaced
// in the findings as evidence. Picks the last non-empty query_metrics result
// (agents tend to confirm root cause with a final metric pull). Logs/traces are
// tabular and already live in the transcript, so they're not duplicated here.
// ---------------------------------------------------------------------------

export function IncidentSummaryTelemetry({ events }: { events: IncidentEvent[] }) {
  const items = buildTranscript(events);
  const metric = items
    .filter(
      (i): i is Extract<TranscriptItem, { type: "telemetry" }> =>
        i.type === "telemetry" && i.kind === "metrics" && i.rows.length > 0,
    )
    .pop();
  if (!metric) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 text-[12px] font-medium text-muted">Cited telemetry</div>
      <TelemetryQueryWidget kind={metric.kind} input={metric.input} rows={metric.rows} />
    </div>
  );
}
