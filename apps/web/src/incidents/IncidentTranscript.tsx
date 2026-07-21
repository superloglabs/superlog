import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { type EvidenceLinkContext, EvidenceMarkdown } from "../EvidenceMarkdown.tsx";
import { LogsTable, TracesTable } from "../Explore.tsx";
import type { IncidentEvent } from "../api.ts";
import { CountChart } from "../dashboards/widgets/CountChart.tsx";
import { DEFAULT_TOP_N } from "../dashboards/widgets/series-topn.ts";
import { Chip, type ChipTone } from "../design/ui.tsx";
import {
  type FeedItem,
  type TranscriptItem,
  buildActivityFeed,
  buildTranscript,
  markAwaitingQuestion,
} from "./incident-activity-feed.ts";
import {
  type TelemetryKind,
  type TelemetryResultState,
  exploreHref,
  formatRangeLabel,
  telemetryResultNotice,
  toLogRows,
  toMetricRows,
  toTraceRows,
} from "./telemetry-result.ts";

export {
  buildActivityFeed,
  buildTranscript,
} from "./incident-activity-feed.ts";

// ---------------------------------------------------------------------------
// IncidentTranscript — renders an agent run's conversation from incident_events:
// messages, telemetry queries as live widgets (charts/tables built from the
// agent's recorded result), and code tool-calls / edits. Lifecycle events stay
// in the timeline; this is only the agent.* conversation.
// ---------------------------------------------------------------------------

// The incident detail's main feed: transcript + lifecycle events on one rail,
// in chronological order.
export function IncidentActivityFeed({
  events,
  triggeringIssue,
  renderIssueCard,
  awaiting,
  evidenceContext,
  investigating = false,
}: {
  events: IncidentEvent[];
  /** The issue that opened the incident. It is projected as the first feed
   *  entry without writing a fictional lifecycle row to incident_events. */
  triggeringIssue?: { issueId: string; createdAt: string } | null;
  /** Renders the referenced issue as a card under issue activity projected
   *  from lifecycle detail or a legacy joined-issue summary. */
  renderIssueCard?: (issueId: string, options?: { showOccurrences?: boolean }) => ReactNode;
  /** When the run paused on `ask_human`, the question is not an incident event
   *  — it lives on the run result. Render it as a terminal node so the timeline
   *  ends on what the agent needs from the human. */
  awaiting?: { question: string; ctx: EvidenceLinkContext } | null;
  /** Link context for markdown evidence recorded by outcome tools. */
  evidenceContext?: EvidenceLinkContext;
  /** Appends a live terminal node while the agent is actively investigating. */
  investigating?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  // The rail hairline is cut at the last node rather than running to the bottom
  // of the container, so no line dangles past the final entry. Measured, since
  // the last node's offset depends on every entry above it.
  const [railHeight, setRailHeight] = useState<number>();

  const ctx = evidenceContext ?? awaiting?.ctx ?? {};
  // The question is sourced only from the current run state, appended as the
  // terminal node so a paused run ends on what it needs from the human.
  const base = buildActivityFeed(events, { triggeringIssue });
  const feed: FeedItem[] = awaiting ? markAwaitingQuestion(base, awaiting.question) : base;

  const renderItem = (item: FeedItem) => {
    if (item.type === "message") return <MessageEntry key={item.id} text={item.text} />;
    if (item.type === "triggering_issue")
      return (
        <IssueActivityEntry
          key={item.id}
          item={item}
          label="Issue detected"
          renderIssueCard={renderIssueCard}
          showOccurrences
          accent
        />
      );
    if (item.type === "issue_activity")
      return (
        <IssueActivityEntry
          key={item.id}
          item={item}
          label={item.label}
          renderIssueCard={renderIssueCard}
        />
      );
    if (item.type === "human") return <HumanEntry key={item.id} item={item} />;
    if (item.type === "telemetry") return <TelemetryEntry key={item.id} item={item} />;
    if (item.type === "memory") return <MemoryEntry key={item.id} item={item} />;
    if (item.type === "tool") return <ToolEntry key={item.id} item={item} ctx={ctx} />;
    if (item.type === "mcp_error") return <McpErrorEntry key={item.id} item={item} />;
    if (item.type === "start") return <StartEntry key={item.id} />;
    if (item.type === "question")
      return (
        <QuestionEntry key={item.id} question={item.question} ctx={ctx} awaiting={item.awaiting} />
      );
    return <LifecycleEntry key={item.id} event={item.event} renderIssueCard={renderIssueCard} />;
  };

  // Collapse only the agent's investigation *steps* (its messages, telemetry
  // queries, and tool calls) between the "Started investigation" node and its
  // final message/question. Lifecycle and external events (status changes, PR /
  // Linear activity, recurrence cards) stay visible, and any that occur after
  // the conclusion render after it — so the timeline reads
  // start → (N steps) → conclusion by default without hiding real activity.
  const isStep = (i: FeedItem) =>
    i.type === "message" ||
    i.type === "telemetry" ||
    i.type === "memory" ||
    i.type === "tool" ||
    i.type === "mcp_error";
  const startIdx = feed.findIndex((i) => i.type === "start");
  let termIdx = -1;
  for (let i = feed.length - 1; i > startIdx; i--) {
    if (feed[i]!.type === "message" || feed[i]!.type === "question") {
      termIdx = i;
      break;
    }
  }
  const region = startIdx >= 0 && termIdx > startIdx ? feed.slice(startIdx + 1, termIdx) : [];
  const stepCount = region.filter(isStep).length;
  const collapsible = stepCount >= 2;

  // Ordered list of rendered nodes (so the last one, whatever its type, can be
  // measured to end the rail at its marker).
  const nodes: ReactNode[] = [];
  if (collapsible) {
    feed.slice(0, startIdx + 1).forEach((i) => nodes.push(renderItem(i)));
    let toggled = false;
    for (const i of region) {
      if (isStep(i)) {
        if (!toggled) {
          nodes.push(
            <CollapseToggle
              key="collapse"
              count={stepCount}
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
            />,
          );
          toggled = true;
        }
        if (expanded) nodes.push(renderItem(i));
      } else {
        nodes.push(renderItem(i)); // lifecycle / external events stay visible
      }
    }
    feed.slice(termIdx).forEach((i) => nodes.push(renderItem(i)));
  } else {
    feed.forEach((i) => nodes.push(renderItem(i)));
  }

  useLayoutEffect(() => {
    const rail = railRef.current;
    const last = lastRef.current;
    if (!rail || !last) return;
    // Rail runs from the first marker center (top-3 ≈ 12px) to the last marker.
    const measure = () => setRailHeight(Math.max(0, last.offsetTop + 1));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rail);
    return () => ro.disconnect();
  }, [nodes.length, expanded]);

  if (nodes.length === 0 && !investigating) return null;

  return (
    <div ref={railRef} className="relative pl-7">
      {nodes.length > 0 && (
        <>
          {/* Start at the first entry's marker center (~12px); cut at the last node
              so no hairline dangles past the final entry. */}
          <div
            className="absolute left-[10px] top-3 w-px bg-border"
            style={railHeight != null ? { height: railHeight } : { bottom: 8 }}
          />
          {nodes.slice(0, -1)}
          <div ref={lastRef}>{nodes[nodes.length - 1]}</div>
        </>
      )}
      {investigating && <InvestigationProgressEntry />}
    </div>
  );
}

const INVESTIGATION_PROGRESS_PHRASES = [
  "Looking for evidence…",
  "Following the signal…",
  "Checking recent changes…",
  "Connecting the clues…",
  "Tracing the failure path…",
  "Comparing related events…",
  "Testing likely causes…",
  "Reviewing the surrounding code…",
  "Ruling out false leads…",
  "Building the incident timeline…",
] as const;
const INVESTIGATION_PROGRESS_DOTS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

function InvestigationProgressEntry() {
  return (
    <div className="-ml-[18px] -mt-1.5 mb-6 flex min-h-[22px] min-w-0 items-center gap-2">
      <span aria-hidden className="grid shrink-0 grid-cols-3 gap-[2px]">
        {INVESTIGATION_PROGRESS_DOTS.map((dot, index) => (
          <span
            key={dot}
            className="investigation-progress-dot h-[2px] w-[2px] rounded-full bg-[#97a3f2]"
            style={{ animationDelay: `${index * -0.12}s` }}
          />
        ))}
      </span>
      <output
        aria-live="polite"
        aria-atomic="true"
        className="flex min-h-[22px] min-w-0 flex-1 items-center"
      >
        <span className="sr-only">Investigation in progress</span>
        <span aria-hidden className="relative block h-4 min-w-0 flex-1 overflow-hidden">
          {INVESTIGATION_PROGRESS_PHRASES.map((phrase, index) => (
            <span
              key={phrase}
              className="investigation-progress-phrase absolute left-0 top-0 block max-w-full truncate text-[12px] font-medium text-muted"
              style={{ animationDelay: `${index * 3}s` }}
            >
              {phrase}
            </span>
          ))}
        </span>
      </output>
    </div>
  );
}

// Collapsed placeholder for the folded investigation steps — a muted node with
// a toggle. Expanding reveals the hidden entries inline above the last message.
function CollapseToggle({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="relative mb-6">
      <span className="absolute -left-7 top-0 grid h-[22px] w-[22px] place-items-center rounded-full border border-border bg-surface-2">
        <svg
          className={`h-3 w-3 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </span>
      <div className="flex min-h-[22px] items-center">
        <button
          type="button"
          onClick={onToggle}
          className="text-[12px] font-medium text-muted hover:text-fg"
        >
          {expanded ? "Hide investigation" : "Show investigation"}
          <span className="ml-1 text-subtle">· {count} steps</span>
        </button>
      </div>
    </div>
  );
}

// The "Started investigation" marker. The raw initial prompt is a
// system-generated brief (incident id, telemetry dump, internal instructions),
// not user content, so it's not surfaced in the timeline — only the node itself.
function StartEntry() {
  return (
    <div className="relative mb-6">
      <span className="absolute -left-7 top-0 grid h-[22px] w-[22px] place-items-center rounded-full border border-accent/40 bg-surface-2">
        <svg
          className="h-3 w-3 text-[#97a3f2]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m5 3 14 9-14 9V3z" />
        </svg>
      </span>
      <div className="flex min-h-[22px] items-center gap-2">
        <span className="text-[12px] font-semibold text-fg">Started investigation</span>
      </div>
    </div>
  );
}

// Terminal node for an `ask_human` pause: the agent's question to the human,
// rendered as markdown inside a warning-toned card so it reads as the open
// action at the end of the trail.
function QuestionEntry({
  question,
  ctx,
  awaiting,
}: {
  question: string;
  ctx: EvidenceLinkContext;
  awaiting: boolean;
}) {
  return (
    <div className="relative mb-6">
      <span className="absolute -left-7 top-0 grid h-[22px] w-[22px] place-items-center rounded-full border border-warning/50 bg-surface-2">
        <svg
          className="h-3 w-3 text-warning"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
      </span>
      <div className="mb-1.5 flex min-h-[22px] items-center gap-2">
        <span className="text-[12px] font-semibold text-fg">Investigation agent</span>
        <Chip tone="warning">{awaiting ? "Awaiting you" : "Asked for input"}</Chip>
      </div>
      <div className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3.5 py-3">
        <EvidenceMarkdown text={question} ctx={ctx} />
      </div>
    </div>
  );
}

function IssueActivityEntry({
  item,
  label,
  renderIssueCard,
  showOccurrences = false,
  accent = false,
}: {
  item: Extract<FeedItem, { type: "triggering_issue" | "issue_activity" }>;
  label: string;
  renderIssueCard?: (issueId: string, options?: { showOccurrences?: boolean }) => ReactNode;
  showOccurrences?: boolean;
  accent?: boolean;
}) {
  const issueCard = renderIssueCard?.(
    item.issueId,
    showOccurrences ? { showOccurrences: true } : undefined,
  );
  return (
    <div className="relative mb-6">
      <Node tone={accent ? "accent" : "muted"}>
        <path d="M12 3v9" />
        <path d="M12 17h.01" />
        <circle cx="12" cy="12" r="9" />
      </Node>
      <div className="mb-1.5 flex min-h-[22px] items-baseline gap-2">
        <span className="text-[12px] font-semibold text-fg">{label}</span>
        <span className="text-[11px] text-subtle">{fmtRelative(item.createdAt)}</span>
      </div>
      {issueCard}
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

// A human message to the investigation, mirrored from whichever channel it
// arrived on (incident chat, Slack thread, PR comment).
function HumanEntry({ item }: { item: Extract<FeedItem, { type: "human" }> }) {
  return (
    <div className="relative mb-6">
      <Node>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </Node>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12px] font-semibold text-fg">{item.author ?? "Teammate"}</span>
        <span className="text-[11px] text-subtle">{fmtRelative(item.createdAt)}</span>
      </div>
      <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg/85">{item.text}</div>
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
  renderIssueCard?: (issueId: string, options?: { showOccurrences?: boolean }) => ReactNode;
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
      <span className="absolute -left-7 top-0 grid h-[22px] w-[22px] place-items-center">
        {actor?.avatarUrl ? (
          <img src={actor.avatarUrl} alt={actor.name ?? ""} className="h-4 w-4 rounded-full" />
        ) : (
          <span className="h-2 w-2 rounded-full border-2 border-border-strong bg-bg" />
        )}
      </span>
      <div className="flex min-h-[22px] flex-wrap items-center gap-x-2 text-[12px] leading-relaxed">
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
        resultState={item.resultState}
        originalRowCount={item.originalRowCount}
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
  resultState,
  originalRowCount,
  isError,
}: {
  kind: TelemetryKind;
  input: Record<string, unknown>;
  rows: Record<string, unknown>[];
  resultState: TelemetryResultState;
  originalRowCount: number | null;
  isError?: boolean;
}) {
  const range = (input.range as { since?: string; until?: string } | undefined) ?? undefined;
  const windowLabel = formatRangeLabel(range);
  const count = rows.length;
  const empty = count === 0;
  const resultNotice = telemetryResultNotice(resultState, count, originalRowCount);

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
        ) : (
          <>
            {resultNotice && (
              <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 font-mono text-[11px] text-warning">
                {resultNotice}
              </div>
            )}
            {empty ? (
              !resultNotice && (
                <div className="py-6 text-center font-mono text-[11px] text-subtle">
                  no rows in this window
                </div>
              )
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
          </>
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

function ToolEntry({
  item,
  ctx,
}: {
  item: Extract<TranscriptItem, { type: "tool" }>;
  ctx: EvidenceLinkContext;
}) {
  const isEdit = EDIT_TOOLS.has(item.name);
  const outcomePresentation = OUTCOME_RECORD_PRESENTATION[item.name];
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
      {isEdit ? (
        <EditEntry item={item} />
      ) : item.name === "list_memories" ? (
        <ListMemoriesEntry item={item} />
      ) : outcomePresentation ? (
        <OutcomeRecordEntry item={item} ctx={ctx} presentation={outcomePresentation} />
      ) : (
        <CodeEntry item={item} />
      )}
    </div>
  );
}

type ListedMemory = {
  id: string;
  kind: string | null;
  title: string | null;
  body: string | null;
};

function listedMemoriesFromResult(result: string | null): ListedMemory[] | null {
  if (!result) return null;
  try {
    const payload = JSON.parse(result) as { memories?: unknown };
    if (!Array.isArray(payload.memories)) return null;
    return payload.memories.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const memory = value as Record<string, unknown>;
      const text = (key: string) =>
        typeof memory[key] === "string" && memory[key] ? (memory[key] as string) : null;
      const id = text("id");
      if (!id) return [];
      return [
        {
          id,
          kind: text("kind"),
          title: text("title"),
          body: text("body"),
        },
      ];
    });
  } catch {
    return null;
  }
}

function ListMemoriesEntry({ item }: { item: Extract<TranscriptItem, { type: "tool" }> }) {
  const memories = listedMemoriesFromResult(item.result);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="text-[12px] font-semibold text-fg">Listed memories</span>
        <span className="font-mono text-[11px] text-subtle">{item.name}</span>
        {memories && (
          <Chip tone="muted">
            {memories.length} {memories.length === 1 ? "memory" : "memories"}
          </Chip>
        )}
        {item.isError && <Chip tone="danger">failed</Chip>}
      </div>
      {memories ? (
        memories.length === 0 ? (
          <div className="px-3.5 py-4 text-[12.5px] text-muted">No active memories.</div>
        ) : (
          <div className="divide-y divide-border">
            {memories.map((memory) => (
              <article key={memory.id} className="px-3.5 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 font-medium text-[13px] text-fg">
                    {memory.title ?? "Untitled memory"}
                  </span>
                  {memory.kind && <Chip tone="muted">{memory.kind}</Chip>}
                  <span className="min-w-0 truncate font-mono text-[10.5px] text-subtle">
                    {memory.id}
                  </span>
                </div>
                {memory.body && (
                  <div className="mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted">
                    {memory.body}
                  </div>
                )}
              </article>
            ))}
          </div>
        )
      ) : item.result ? (
        <div
          className={`whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[11.5px] leading-relaxed ${
            item.isError ? "text-danger" : "text-muted"
          }`}
        >
          {item.result}
        </div>
      ) : (
        <div className="px-3.5 py-4 text-[12.5px] text-muted">No result recorded.</div>
      )}
    </div>
  );
}

type OutcomeRecordField = {
  key: string;
  label: string;
  sourceKeys?: string[];
  read?: (input: Record<string, unknown>) => unknown;
};

type OutcomeRecordPresentation = {
  title: string;
  fields: OutcomeRecordField[];
};

const OUTCOME_RECORD_PRESENTATION: Record<string, OutcomeRecordPresentation> = {
  report_findings: {
    title: "Reported findings",
    fields: [
      { key: "summary", label: "Summary" },
      { key: "proposedTitle", label: "Proposed title" },
      { key: "rootCause", label: "Root cause" },
      { key: "rootCauseConfidence", label: "Root cause confidence" },
      { key: "estimatedImpact", label: "Estimated impact" },
      { key: "impactConfidence", label: "Impact confidence" },
      { key: "severity", label: "Severity" },
      { key: "handoffNotes", label: "Handoff notes" },
    ],
  },
  silence_as_noise: {
    title: "Silenced as noise",
    fields: [
      { key: "issueId", label: "Issue" },
      { key: "reason", label: "Reasoning" },
      { key: "evidence", label: "Evidence" },
    ],
  },
  place_under_observation: {
    title: "Placed under observation",
    fields: [
      { key: "issueId", label: "Issue" },
      { key: "reason", label: "Reasoning" },
      { key: "evidence", label: "Evidence" },
      {
        key: "escalationTrigger",
        label: "Escalation trigger",
        sourceKeys: ["escalateOn", "threshold"],
        read: formatEscalationTrigger,
      },
    ],
  },
  resolve_issue: {
    title: "Resolved issue",
    fields: [
      { key: "issueId", label: "Issue" },
      { key: "reason", label: "Reasoning" },
      { key: "evidence", label: "Evidence" },
    ],
  },
  resolve_incident: {
    title: "Resolved incident",
    fields: [
      { key: "reason", label: "Reasoning" },
      { key: "evidence", label: "Evidence" },
    ],
  },
};

function humanizeFieldName(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function formatEscalationTrigger(input: Record<string, unknown>): string | null {
  const threshold = input.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return null;
  const events = threshold === 1 ? "event" : "events";
  if (input.escalateOn === "events_per_minute") {
    return `${threshold} ${events} per minute (trailing 5-minute average)`;
  }
  if (input.escalateOn === "additional_events") {
    return `${threshold} additional ${events}`;
  }
  return null;
}

function outcomeRecordFields(
  item: Extract<TranscriptItem, { type: "tool" }>,
  presentation: OutcomeRecordPresentation,
) {
  const knownKeys = new Set(
    presentation.fields.flatMap((field) => [field.key, ...(field.sourceKeys ?? [])]),
  );
  const fields: OutcomeRecordField[] = [
    ...presentation.fields,
    ...Object.keys(item.input)
      .filter((key) => !knownKeys.has(key))
      .map((key) => ({ key, label: humanizeFieldName(key) })),
  ];
  return fields.flatMap((field) => {
    const value = field.read?.(item.input) ?? item.input[field.key];
    if (value == null || value === "") return [];
    return [{ ...field, value }];
  });
}

function OutcomeRecordEntry({
  item,
  ctx,
  presentation,
}: {
  item: Extract<TranscriptItem, { type: "tool" }>;
  ctx: EvidenceLinkContext;
  presentation: OutcomeRecordPresentation;
}) {
  const fields = outcomeRecordFields(item, presentation);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="text-[12px] font-semibold text-fg">{presentation.title}</span>
        <span className="font-mono text-[11px] text-subtle">{item.name}</span>
        {item.isError && <Chip tone="danger">failed</Chip>}
      </div>
      <div className="divide-y divide-border">
        {fields.map(({ key, label, value }) => (
          <div key={key} className="grid gap-1.5 px-3.5 py-3 sm:grid-cols-[150px_minmax(0,1fr)]">
            <div className="text-[11px] font-medium text-muted">{label}</div>
            <div className="min-w-0">
              {typeof value === "string" ? (
                <EvidenceMarkdown text={value} ctx={ctx} />
              ) : (
                <span className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg">
                  {typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}
                </span>
              )}
            </div>
          </div>
        ))}
        {item.isError && item.result && (
          <div className="grid gap-1.5 px-3.5 py-3 sm:grid-cols-[150px_minmax(0,1fr)]">
            <div className="text-[11px] font-medium text-muted">Result</div>
            <div className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-danger">
              {item.result}
            </div>
          </div>
        )}
      </div>
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
        {item.serverName && <Chip tone="muted">{item.serverName}</Chip>}
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

function McpErrorEntry({ item }: { item: Extract<TranscriptItem, { type: "mcp_error" }> }) {
  return (
    <div className="relative mb-6">
      <Node>
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <circle cx="12" cy="12" r="9" />
      </Node>
      <div className="rounded-lg border border-danger/30 bg-danger/[0.05] px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold text-fg">MCP {item.category} failed</span>
          {item.serverName && <Chip tone="danger">{item.serverName}</Chip>}
        </div>
        <div className="mt-1.5 break-words font-mono text-[11.5px] text-danger">{item.message}</div>
      </div>
    </div>
  );
}

function MemoryEntry({ item }: { item: Extract<TranscriptItem, { type: "memory" }> }) {
  const label = item.isError
    ? item.action === "updated"
      ? "Memory update failed"
      : "Memory save failed"
    : item.action === "updated"
      ? "Updated memory"
      : "Saved memory";
  const fallbackTitle = item.memoryId ? `Memory ${item.memoryId}` : "Project memory";
  const title = item.title ?? fallbackTitle;
  const result = (item.result ?? "").trim();
  return (
    <div className="relative mb-6">
      <Node tone="accent">
        <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </Node>
      <div className="mb-1.5 flex min-h-[22px] flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-fg">{label}</span>
        {item.kind && <Chip tone="muted">{item.kind}</Chip>}
        {item.status && (
          <Chip tone={item.status === "archived" ? "warning" : "muted"}>{item.status}</Chip>
        )}
        {item.isError && <Chip tone="danger">failed</Chip>}
      </div>
      <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        {item.body && (
          <div className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted">
            {item.body}
          </div>
        )}
        {result && item.isError && (
          <div className="mt-2 line-clamp-2 break-all font-mono text-[11px] text-danger">
            {result.slice(0, 240)}
          </div>
        )}
      </div>
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
      <TelemetryQueryWidget
        kind={metric.kind}
        input={metric.input}
        rows={metric.rows}
        resultState={metric.resultState}
        originalRowCount={metric.originalRowCount}
      />
    </div>
  );
}
