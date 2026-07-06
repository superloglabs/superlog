import { type ReactNode, useEffect, useState } from "react";
import { LogsTable, TracesTable } from "../../Explore.tsx";
import { IncidentDetailContent, IncidentRow } from "../../Issues.tsx";
import type {
  AgentRun,
  Incident,
  IncidentEvent,
  IncidentListItem,
  Issue,
  LogRow,
  MetricSeriesRow,
} from "../../api.ts";
import { CountChart } from "../../dashboards/widgets/CountChart.tsx";
import { DEFAULT_TOP_N } from "../../dashboards/widgets/series-topn.ts";
import { Btn, Chip, type ChipTone, Tile } from "../ui.tsx";

// ---------------------------------------------------------------------------
// Investigations playground — /design/investigations
//
// A real-component mockup (fixtures only, no backend) of four proposed
// capabilities on the incidents feature:
//   A. Start a custom agent run from a typed prompt.
//   B. The "new investigation" prompt modal.
//   C. A full-page investigation view whose transcript renders each telemetry
//      query the agent ran as a chart/table widget, stamped with the window the
//      agent chose.
//   D. A summary panel that quotes telemetry via the same widgets.
//
// Every chart/table/row/button is the live component from the app; only the
// data is mock. See /design/issues for the same pattern on the incident list.
// ---------------------------------------------------------------------------

type Surface = "list" | "full" | "drawer" | "real";

export function InvestigationsPlayground() {
  const [surface, setSurface] = useState<Surface>("list");
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <SubpageNav crumb="Investigations" />
      <SurfaceToolbar active={surface} onChange={setSurface} />
      <main className="mx-auto max-w-6xl px-6 pb-24 pt-8">
        {surface === "list" && <ListSurface onNew={() => setModalOpen(true)} onOpen={setSurface} />}
        {surface === "full" && <FullInvestigationSurface />}
        {surface === "drawer" && <DrawerSurface />}
        {surface === "real" && <RealIncidentSurface />}
      </main>
      {modalOpen && (
        <NewInvestigationModal
          onClose={() => setModalOpen(false)}
          onStart={() => {
            setModalOpen(false);
            setSurface("full");
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome (mirrors the other /design playgrounds)
// ---------------------------------------------------------------------------

function SubpageNav({ crumb }: { crumb: string }) {
  return (
    <header className="relative z-10">
      <div className="px-6">
        <nav className="flex items-center justify-start gap-3 py-5">
          <a
            href="/design"
            className="text-[14px] font-medium text-muted transition-opacity hover:text-fg"
          >
            ← Design
          </a>
          <span className="text-[14px] text-subtle">/</span>
          <span className="text-[14px] font-medium text-fg">{crumb}</span>
        </nav>
      </div>
      <div style={{ height: "0.5px", background: "rgba(255,255,255,0.07)" }} />
    </header>
  );
}

function SurfaceToolbar({ active, onChange }: { active: Surface; onChange: (s: Surface) => void }) {
  const options: { id: Surface; label: string }[] = [
    { id: "list", label: "Incident list" },
    { id: "full", label: "Full investigation" },
    { id: "drawer", label: "In-context drawer" },
    { id: "real", label: "Reconstructed incident" },
  ];
  return (
    <div className="border-y border-accent/30 bg-accent-soft">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-2.5">
        <span className="text-[12px] font-medium text-accent">Surface</span>
        <div className="flex flex-wrap items-center gap-1">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id)}
              className={
                active === o.id
                  ? "rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-accent-ink"
                  : "rounded-md px-3 py-1 text-[12px] font-medium text-accent hover:bg-accent/10"
              }
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-accent/70">
          mockup · real components, fixture data
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A. Incident list with the "New investigation" entry point
// ---------------------------------------------------------------------------

function ListSurface({ onNew, onOpen }: { onNew: () => void; onOpen: (s: Surface) => void }) {
  return (
    <div>
      <div className="mb-6 flex items-start gap-4">
        <div>
          <h1 className="text-[32px] font-semibold tracking-tight text-fg">Incidents</h1>
          <p className="mt-1 text-[13px] text-muted">
            Auto-detected from your telemetry — plus investigations you start by hand.
          </p>
        </div>
        <div className="ml-auto pt-2">
          <Btn variant="primary" onClick={onNew}>
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            New investigation
          </Btn>
        </div>
      </div>

      <div className="mb-6 flex items-center gap-3 rounded-lg border border-dashed border-border-strong bg-accent-soft px-4 py-3">
        <svg
          className="h-4 w-4 flex-none text-accent"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="text-[13px] text-fg">
          <span className="font-medium">Something feels off but nothing alerted?</span> Start an
          investigation from a hunch — the agent queries your telemetry and reports back, even when
          no incident fired.
        </span>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-sm border border-border bg-surface-2 p-0.5">
          {["Open", "Resolved", "All"].map((label) => (
            <button
              key={label}
              type="button"
              className={
                label === "Open"
                  ? "rounded-[2px] bg-surface-3 px-3 py-1 text-[12px] font-medium text-fg"
                  : "px-3 py-1 text-[12px] font-medium text-muted hover:text-fg"
              }
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[12px] tabular-nums text-muted">{LIST_ROWS.length} incidents</span>
      </div>

      <div className="divide-y divide-border border border-border">
        {LIST_ROWS.map((row) => (
          <IncidentRow
            key={row.incident.id}
            row={row}
            selected={false}
            onClick={() => onOpen(row.incident.id === MANUAL_INCIDENT.id ? "full" : "drawer")}
          />
        ))}
      </div>
      <p className="mt-3 font-mono text-[11px] text-subtle">
        The top row is a manual investigation (opens the full view) · others open the drawer.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B. New-investigation prompt modal
// ---------------------------------------------------------------------------

function NewInvestigationModal({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative w-full max-w-[540px] overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl">
        <div className="px-5 pt-5">
          <h2 className="text-[17px] font-semibold tracking-tight text-fg">New investigation</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Describe what feels wrong. The agent will query your telemetry — traces, logs and
            metrics — and report back, even if nothing alerted.
          </p>
        </div>
        <div className="px-5 py-4">
          <div className="mb-2 text-[12px] font-medium text-muted">
            What should the agent look into?
          </div>
          <textarea
            rows={4}
            defaultValue={
              "Checkout feels slow for some users in the last hour, but no incident fired. Can you check whether there's elevated latency or errors on the checkout path, and tell me if it's real?"
            }
            className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-[14px] leading-relaxed text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-muted">Scope</span>
            <Segmented options={["Production", "Staging"]} />
            <Segmented options={["checkout", "All services"]} />
          </div>
          <div className="mt-4 flex items-start gap-2">
            <svg
              className="mt-0.5 h-3.5 w-3.5 flex-none text-accent"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
            <p className="text-[12px] leading-relaxed text-muted">
              The agent decides which signals to pull and over what time window — each query it runs
              shows up as a chart in the transcript.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-surface px-5 py-3.5">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={onStart}>
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="m5 3 14 9-14 9z" />
            </svg>
            Start investigation
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Segmented({ options }: { options: string[] }) {
  const [active, setActive] = useState(0);
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-border">
      {options.map((o, i) => (
        <button
          key={o}
          type="button"
          onClick={() => setActive(i)}
          className={
            active === i
              ? "bg-surface-3 px-3 py-1.5 text-[12px] text-fg"
              : "px-3 py-1.5 text-[12px] text-muted hover:text-fg"
          }
        >
          {o}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// C. Full-page investigation — transcript with telemetry widgets + summary
// ---------------------------------------------------------------------------

const WINDOW_LABEL = "13:10 – 14:10 UTC · step 2m";
// The window the agent queried — pins each widget's x-axis to this range, the
// same way a dashboard widget is pinned to its dashboard range.
const WINDOW_RANGE = { since: "2026-06-26T13:10:00Z", until: "2026-06-26T14:10:00Z" };

// Stable ref so CountChart's series memo doesn't recompute each render.
const metricValue = (r: MetricSeriesRow) => r.value;

// A telemetry chart rendered with the real dashboard-widget renderer (CountChart,
// ECharts) rather than the Explore chart — so investigation widgets and dashboard
// widgets are the same component.
function WidgetChart({
  rows,
  chartType,
  height,
  compact = false,
  range = WINDOW_RANGE,
  step = "2 MINUTE",
}: {
  rows: MetricSeriesRow[];
  chartType: "line" | "bar";
  height: number;
  compact?: boolean;
  range?: { since: string; until: string };
  step?: string;
}) {
  return (
    <div style={{ height }}>
      <CountChart
        rows={rows}
        value={metricValue}
        range={range}
        step={step}
        chartType={chartType}
        limit={DEFAULT_TOP_N}
        showXAxis={!compact}
        showYAxis={!compact}
        showLegend={false}
        legendPosition="side"
      />
    </div>
  );
}

function FullInvestigationSurface() {
  const [phase, setPhase] = useState<"working" | "complete">("complete");
  const working = phase === "working";
  return (
    <div className="mx-auto max-w-3xl">
      {/* mock control: preview both run states */}
      <div className="mb-5 flex items-center gap-2">
        <span className="text-[12px] text-muted">Preview state</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-border">
          {(["working", "complete"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPhase(p)}
              className={
                phase === p
                  ? "bg-surface-3 px-3 py-1.5 text-[12px] capitalize text-fg"
                  : "px-3 py-1.5 text-[12px] capitalize text-muted hover:text-fg"
              }
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-5 flex items-center gap-3">
        <div>
          <div className="text-[12px] text-muted">INV-2291 · ghost-otter</div>
          <h1 className="mt-1 text-[28px] font-semibold tracking-tight text-fg">
            Checkout feels slow for some users
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {working ? (
            <>
              <Chip tone="accent" dot>
                investigating · 3 queries
              </Chip>
              <Btn variant="ghost" size="sm">
                Stop
              </Btn>
            </>
          ) : (
            <>
              <Chip tone="success" dot>
                complete · 1m 42s
              </Chip>
              <Btn variant="ghost" size="sm">
                Re-run
              </Btn>
            </>
          )}
        </div>
      </div>

      <Brief className="mb-6" />

      {working ? (
        // While the agent is running: the transcript is the whole view.
        <section>
          <h2 className="mb-4 text-[15px] font-semibold tracking-tight text-fg">Transcript</h2>
          <Transcript />
          <div className="mt-2 flex items-center gap-2 pl-7 text-[13px] text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Querying telemetry…
          </div>
        </section>
      ) : (
        // Once it's done: collapse the transcript above the summary.
        <div className="flex flex-col gap-6">
          <CollapsibleTranscript />
          <SummaryPanel />
        </div>
      )}
    </div>
  );
}

// Sentence-case section label — replaces the mono-uppercase eyebrow.
function MetaLabel({ children }: { children: ReactNode }) {
  return <div className="text-[12px] font-medium text-muted">{children}</div>;
}

// A telemetry chart the summary "quotes" — a compact widget card stamped with
// the agent's window. Used in the standalone summary and inside the incident
// drawer's Summary section.
function CitedWidget({
  title,
  badge,
  rows,
  chartType = "line",
}: {
  title: string;
  badge: string;
  rows: MetricSeriesRow[];
  chartType?: "line" | "bar";
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium text-fg">{title}</span>
        <Chip tone="danger">{badge}</Chip>
      </div>
      <div className="px-3 py-2">
        <WidgetChart rows={rows} chartType={chartType} height={120} compact />
      </div>
      <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted">
        {WINDOW_LABEL}
      </div>
    </div>
  );
}

function Brief({ className = "" }: { className?: string }) {
  return (
    <Tile className={className}>
      <MetaLabel>The brief you gave the agent</MetaLabel>
      <p className="mt-2 text-[14px] leading-relaxed text-fg">
        “Checkout feels slow for some users in the last hour, but no incident fired. Can you check
        whether there's elevated latency or errors on the checkout path, and tell me if it's real?”
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-[10px] font-semibold text-accent-ink">
          AS
        </span>
        Arseniy · started manually 1m ago · scope
        <Chip tone="muted">checkout</Chip>
        <Chip tone="muted">production</Chip>
      </div>
    </Tile>
  );
}

function Transcript() {
  return (
    <div className="relative pl-7">
      <div className="absolute bottom-2 left-[10px] top-1 w-px bg-border" />

      <TrailEntry kind="plan" who="Investigation agent · plan">
        I'll compare the checkout path against the previous hour — span latency first, then error
        logs, then the database pool. That combination usually separates a real regression from
        noise.
      </TrailEntry>

      <TrailEntry kind="traces" who="Queried traces">
        p95 latency on <Mono>POST /checkout</Mono> is climbing — flat near 240 ms until 13:40, then
        a steady ramp to ~760 ms. It never crosses the 1 s alert threshold, which is why nothing
        fired.
        <TelemetryWidget
          fn="query_traces"
          filters={[
            { label: "span = POST /checkout", tone: "muted" },
            { label: "p95 duration", tone: "muted" },
          ]}
          title="Checkout p95 latency"
          badge="+217%"
          badgeTone="warning"
        >
          <WidgetChart rows={LATENCY_ROWS} chartType="line" height={150} />
        </TelemetryWidget>
      </TrailEntry>

      <TrailEntry kind="logs" who="Queried logs">
        Error logs back this up: a small but rising trickle of <Mono>pool timeout</Mono> errors from
        the checkout service starting 13:42 — 38 in the window, all <Mono>QueryTimeoutError</Mono>.
        <TelemetryWidget
          fn="query_logs"
          filters={[
            { label: "service = checkout", tone: "muted" },
            { label: "severity = ERROR", tone: "danger" },
          ]}
          title="Checkout error logs"
          badge="38 events"
          badgeTone="danger"
        >
          <WidgetChart rows={ERROR_ROWS} chartType="bar" height={130} />
          <details className="mt-3 border-t border-border pt-3">
            <summary className="cursor-pointer text-[12px] text-muted">
              Show 3 sample log lines
            </summary>
            <div className="mt-2 overflow-x-auto">
              <LogsTable rows={LOG_ROWS} />
            </div>
          </details>
        </TelemetryWidget>
      </TrailEntry>

      <TrailEntry kind="metrics" who="Queried metrics">
        Root cause confirmed: <Mono>db.pool.in_use</Mono> is pinned at the max of 20 since 13:40.
        The pool is saturated, so checkout requests queue for a connection — that's the latency, and
        the overflow is what's timing out.
        <TelemetryWidget
          fn="query_metrics"
          filters={[
            { label: "db.pool.in_use", tone: "muted" },
            { label: "max", tone: "muted" },
          ]}
          title="DB connection pool in use"
          badge="20 / 20"
          badgeTone="danger"
        >
          <WidgetChart rows={POOL_ROWS} chartType="line" height={150} />
        </TelemetryWidget>
      </TrailEntry>

      <TrailEntry kind="done" who="Investigation agent · done · 1m 42s">
        Wrote up findings → see the summary. This is a real, slow-burn regression that sits just
        under your alert threshold.
      </TrailEntry>
    </div>
  );
}

function CollapsibleTranscript({
  body = <Transcript />,
  meta = "3 telemetry queries · 5 steps · 1m 42s",
}: {
  body?: ReactNode;
  meta?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-xl border border-border bg-surface"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <svg
          className={`h-4 w-4 flex-none text-muted transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span className="text-[15px] font-semibold tracking-tight text-fg">Transcript</span>
        <span className="text-[12px] text-muted">{meta}</span>
        <span className="ml-auto text-[12px] text-muted">{open ? "Hide" : "Show"}</span>
      </summary>
      <div className="border-t border-border px-4 pb-3 pt-5">{body}</div>
    </details>
  );
}

function SummaryPanel() {
  return (
    <div>
      <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-fg">Summary</h2>
      <div className="rounded-xl border border-accent/25 bg-surface p-5 shadow-[0_18px_40px_-28px_rgba(72,90,226,0.5)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-fg">Verdict</h3>
          <Chip tone="warning" dot>
            below alert threshold
          </Chip>
        </div>
        <p className="max-w-[68ch] text-[14px] leading-relaxed text-fg/90">
          Checkout p95 latency rose <strong className="text-fg">+217%</strong> (240 ms → 760 ms)
          over the last 30 minutes without alerting, because it stays under the 1 s rule. The cause
          is a <strong className="text-fg">saturated database connection pool</strong> — pinned at
          20/20 since 13:40, forcing requests to queue and the overflow to time out.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div>
            <MetaLabel>Evidence · cited</MetaLabel>
            <div className="mt-2">
              <CitedWidget title="Pool saturation" badge="20/20" rows={POOL_ROWS} />
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div>
              <MetaLabel>Estimated impact</MetaLabel>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-fg/90">
                ~<strong className="text-fg">4.2%</strong> of checkout sessions in the window saw
                &gt;1.5 s response times. Trending up.
              </p>
            </div>
            <div>
              <MetaLabel>Recommended next step</MetaLabel>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-fg/90">
                Raise the checkout pool size, or add a latency-budget alert at 600 ms p95 so this
                class of slow-burn fires earlier.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Btn variant="primary" size="sm">
            Promote to incident
          </Btn>
          <Btn variant="ghost" size="sm">
            Add alert
          </Btn>
          <span className="ml-auto font-mono text-[11px] text-subtle">
            manual · 3 queries · claude-opus-4-8 · 1m 42s
          </span>
        </div>
      </div>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12.5px] text-[#c7cdf6]">
      {children}
    </code>
  );
}

const TRAIL_ICONS: Record<string, ReactNode> = {
  plan: <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z" />,
  traces: (
    <>
      <path d="M3 3v18h18" />
      <path d="m7 14 4-4 3 3 5-6" />
    </>
  ),
  logs: <path d="M4 5h16M4 12h16M4 19h10" />,
  metrics: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    </>
  ),
  done: <path d="M20 6 9 17l-5-5" />,
  code: (
    <>
      <path d="m9 18 6-6-6-6" transform="translate(-3 0)" />
      <path d="m15 6 6 6-6 6" transform="translate(-3 0)" />
    </>
  ),
  edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
};

function TrailEntry({
  kind,
  who,
  children,
}: {
  kind: keyof typeof TRAIL_ICONS | string;
  who: string;
  children: ReactNode;
}) {
  return (
    <div className="relative mb-6">
      <span className="absolute -left-7 top-0.5 grid h-[22px] w-[22px] place-items-center rounded-full border border-accent/40 bg-surface-2">
        <svg
          className="h-3 w-3 text-[#97a3f2]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {TRAIL_ICONS[kind] ?? TRAIL_ICONS.plan}
        </svg>
      </span>
      <div className="mb-1.5 text-[12px] font-semibold text-fg">{who}</div>
      <div className="text-[14px] leading-relaxed text-fg/85">{children}</div>
    </div>
  );
}

function TelemetryWidget({
  fn,
  filters,
  title,
  badge,
  badgeTone,
  children,
  windowLabel = WINDOW_LABEL,
}: {
  fn: string;
  filters: { label: string; tone: ChipTone }[];
  title: string;
  badge: string;
  badgeTone: ChipTone;
  children: ReactNode;
  windowLabel?: string;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3.5 py-2">
        <span className="font-mono text-[11.5px] text-[#97a3f2]">{fn}</span>
        <span className="text-subtle">·</span>
        {filters.map((f) => (
          <Chip key={f.label} tone={f.tone}>
            {f.label}
          </Chip>
        ))}
      </div>
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <span className="text-[13px] font-semibold text-fg">{title}</span>
        <Chip tone={badgeTone}>{badge}</Chip>
      </div>
      <div className="px-3.5 pb-3.5">{children}</div>
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
        window <span className="font-mono text-fg">{windowLabel}</span>
        <span className="ml-auto">
          <Btn variant="ghost" size="sm">
            Open in Explore
          </Btn>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A code tool-call in the transcript (grep / read / bash / glob), de-emphasized
// relative to the agent's telemetry and prose.
// ---------------------------------------------------------------------------

function CodeStep({
  tool,
  arg,
  result,
  ok = false,
}: {
  tool: string;
  arg: string;
  result?: string;
  ok?: boolean;
}) {
  return (
    <div className="relative mb-6">
      <span className="absolute -left-7 top-0.5 grid h-[22px] w-[22px] place-items-center rounded-full border border-border bg-surface-2">
        <svg
          className="h-3 w-3 text-muted"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m8 6-6 6 6 6" />
          <path d="m16 6 6 6-6 6" />
        </svg>
      </span>
      <div className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12px]">
        <div className="flex items-center gap-2">
          <span className="text-muted">{tool}</span>
          <span className="truncate text-fg">{arg}</span>
        </div>
        {result && (
          <div className={`mt-1 truncate ${ok ? "text-success" : "text-subtle"}`}>{result}</div>
        )}
      </div>
    </div>
  );
}

type DiffLine = { t: "add" | "del" | "ctx"; text: string };

function DiffBlock({ file, lines }: { file: string; lines: DiffLine[] }) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-muted">
        {file}
      </div>
      <div className="overflow-x-auto bg-[#161618] px-3 py-2 font-mono text-[11.5px] leading-relaxed">
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.t === "add" ? "text-success" : l.t === "del" ? "text-danger" : "text-subtle"
            }
          >
            <span className="select-none opacity-60">
              {l.t === "add" ? "+ " : l.t === "del" ? "- " : "  "}
            </span>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// E. Reconstructed incident — drives the shipped IncidentDetailContent + the
//    data-driven transcript renderer from a fixture of incident_events, so the
//    messages, telemetry widgets, code steps and diff all render from events.
// ---------------------------------------------------------------------------

const REAL_WINDOW = { since: "2026-06-26T02:45:00Z", until: "2026-06-26T03:05:00Z" };

function RealTranscript() {
  return (
    <div className="relative pl-7">
      <div className="absolute bottom-2 left-[10px] top-1 w-px bg-border" />

      <TrailEntry kind="plan" who="Investigation agent · plan">
        I'll investigate this production auth signin failure spike — starting with the telemetry to
        understand the scope and nature of the incident.
      </TrailEntry>

      <TrailEntry kind="metrics" who="Queried metrics">
        The counter is pinned at <Mono>value=2</Mono>, re-emitted every 5 seconds for the entire
        window — suspiciously flat for a “spike.” A real credential-stuffing attack would be bursty.
        <TelemetryWidget
          fn="query_metrics"
          filters={[
            { label: "auth.signin.failures", tone: "muted" },
            { label: "env = prod", tone: "muted" },
          ]}
          title="auth.signin.failures · cumulative sum"
          badge="flat = 2"
          badgeTone="warning"
          windowLabel="02:45 – 03:05 UTC · step 1m"
        >
          <WidgetChart
            rows={SIGNIN_ROWS}
            chartType="line"
            height={150}
            range={REAL_WINDOW}
            step="1 MINUTE"
          />
        </TelemetryWidget>
      </TrailEntry>

      <TrailEntry kind="traces" who="Queried traces">
        The real events: exactly 4 <Mono>POST /api/auth/events</Mono> beacons at ~02:51 — the
        counter steps 0→1→2, then nothing. No sustained traffic behind the “62 failures.”
        <TelemetryWidget
          fn="query_traces"
          filters={[
            { label: "http.target = /api/auth/events", tone: "muted" },
            { label: "env = prod", tone: "muted" },
          ]}
          title="Auth-event beacons around the alert"
          badge="4 spans"
          badgeTone="neutral"
          windowLabel="02:40 – 03:00 UTC"
        >
          <div className="overflow-x-auto">
            <TracesTable rows={REAL_TRACES} />
          </div>
        </TelemetryWidget>
      </TrailEntry>

      <CodeStep tool="grep" arg="recordFailureMetric" result="lib/metrics/booking-metrics.ts" />
      <CodeStep
        tool="read"
        arg="lib/metrics/booking-metrics.ts"
        result="PeriodicExportingMetricReader · exportIntervalMillis: 5000  // Faster export for testing"
      />

      <TrailEntry kind="plan" who="Investigation agent">
        Confirmed. <Mono>OTLPMetricExporter</Mono> defaults to{" "}
        <strong className="text-fg">CUMULATIVE</strong> temporality, so the lifetime total (2) is
        re-emitted on every 5 s tick. The alert sums raw points → 62 “failures” in 5 min from 2 real
        ones.
      </TrailEntry>

      <TrailEntry kind="edit" who="Edited lib/metrics/booking-metrics.ts">
        Fix: DELTA temporality on both exporters, and raise the test-only 5 s interval to 60 s.
        <DiffBlock file="lib/metrics/booking-metrics.ts" lines={REAL_DIFF} />
      </TrailEntry>

      <CodeStep
        tool="bash"
        arg="npx vitest run app/api/auth/events/route.test.ts"
        result="✓ 3 tests passed"
        ok
      />

      <TrailEntry kind="done" who="Investigation agent · done">
        Submitted findings and opened a PR with the DELTA-temporality fix.
      </TrailEntry>
    </div>
  );
}

// The auth.signin.failures widget the agent's summary quotes (real flat-at-2 series).
function SigninCitedWidget() {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium text-fg">auth.signin.failures · cumulative</span>
        <Chip tone="warning">flat = 2</Chip>
      </div>
      <div className="px-3 py-2">
        <WidgetChart
          rows={SIGNIN_ROWS}
          chartType="line"
          height={100}
          compact
          range={REAL_WINDOW}
          step="1 MINUTE"
        />
      </div>
      <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted">
        02:45 – 03:05 UTC
      </div>
    </div>
  );
}

function RealIncidentSurface() {
  const [view, setView] = useState<"full" | "drawer">("full");
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-center gap-2">
        <span className="text-[12px] text-muted">View</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-border">
          {(
            [
              ["full", "Full page"],
              ["drawer", "Side drawer"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={
                view === id
                  ? "bg-surface-3 px-3 py-1.5 text-[12px] text-fg"
                  : "px-3 py-1.5 text-[12px] text-muted hover:text-fg"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "drawer" ? <RealDrawer /> : <RealFullPage />}
    </div>
  );
}

// The real incident in the actual right-side incident drawer (IncidentDetailContent),
// fed the real findings + the rich transcript + cited telemetry in its summary.
function RealDrawer() {
  return (
    <div className="relative min-h-[820px] overflow-hidden rounded-lg border border-border bg-surface/40">
      <div className="absolute inset-0 bg-black/40" />
      <aside className="absolute inset-y-0 right-0 w-full max-w-[680px] overflow-y-auto border-l border-border bg-bg p-5 shadow-2xl">
        <IncidentDetailContent
          incident={REAL_INCIDENT}
          issues={[]}
          agentRun={REAL_AGENT_RUN}
          events={UMBER_OCELOT_EVENTS}
          eventsLoading={false}
          eventsError={null}
          onClose={() => {}}
          onViewIssue={() => {}}
          onStatusAction={() => {}}
          updatingIncident={false}
          summaryTelemetry={
            <div className="pt-1">
              <MetaLabel>Cited telemetry</MetaLabel>
              <div className="mt-2">
                <SigninCitedWidget />
              </div>
            </div>
          }
        />
      </aside>
    </div>
  );
}

function RealFullPage() {
  return (
    <div>
      <div className="mb-5 rounded-lg border border-dashed border-border-strong bg-accent-soft px-4 py-2.5 text-[12px] leading-relaxed text-muted">
        Reconstructed from an agent run's <code className="font-mono text-fg">incident_events</code>{" "}
        — messages, telemetry queries (as widgets), code steps and the diff all render from stored
        events.
      </div>

      <div className="mb-1 text-[12px] text-muted">INC · amber-koala · core-platform · prod</div>
      <h1 className="mb-3 text-[25px] font-semibold leading-tight tracking-tight text-fg">
        auth.signin.failures alert fires false positives from CUMULATIVE metric re-export
      </h1>
      <div className="mb-7 flex flex-wrap items-center gap-2">
        <Chip tone="warning">SEV-3</Chip>
        <Chip tone="success" dot>
          complete · ~4m
        </Chip>
        <Chip tone="muted">auto · alert-triggered</Chip>
        <Chip tone="muted">12 telemetry queries</Chip>
      </div>

      <h2 className="mb-4 text-[15px] font-semibold tracking-tight text-fg">Transcript</h2>
      <RealTranscript />

      <div className="mt-8">
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-fg">Summary</h2>
        <div className="rounded-xl border border-accent/25 bg-surface p-5 shadow-[0_18px_40px_-28px_rgba(72,90,226,0.5)]">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-fg">Verdict</h3>
            <Chip tone="warning" dot>
              false positive · noise
            </Chip>
          </div>
          <p className="max-w-[68ch] text-[14px] leading-relaxed text-fg/90">
            Two real signin failures at ~02:51 UTC set the <Mono>auth.signin.failures</Mono> counter
            to 2. OTel's <strong className="text-fg">CUMULATIVE temporality</strong> plus a
            test-only 5 s export interval re-emitted that total every 5 seconds — so the alert
            counted <strong className="text-fg">62 “failures”</strong> in a 5-minute window instead
            of the actual 2.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div>
              <MetaLabel>Evidence · cited</MetaLabel>
              <div className="mt-2">
                <SigninCitedWidget />
              </div>
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <MetaLabel>Estimated impact</MetaLabel>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-fg/90">
                  The credential-stuffing alert is the primary signal for the signin endpoint;
                  recurring false positives erode trust and risk alert fatigue on a security signal.
                </p>
              </div>
              <div>
                <MetaLabel>Fix</MetaLabel>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-fg/90">
                  <Mono>DELTA</Mono> temporality on both exporters + 60 s interval, so a window sums
                  to the real count.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Btn variant="primary" size="sm">
              View PR
            </Btn>
            <Chip tone="success" dot>
              PR · superlog/fix-metrics-delta-temporality
            </Chip>
            <span className="ml-auto font-mono text-[11px] text-subtle">
              auto · 12 queries · claude-opus · ~4m
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D. In-context drawer — the live IncidentDetailContent with all its data, with
//    one addition: the Summary section quotes telemetry via a widget.
// ---------------------------------------------------------------------------

function DrawerSurface() {
  return (
    <div>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-fg">In-context drawer</h2>
        <span className="text-[12px] text-muted">
          the live <code className="font-mono">IncidentDetailContent</code> — same data as today,
          with the Summary now able to quote telemetry
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <IncidentDetailContent
          incident={MANUAL_INCIDENT}
          issues={[]}
          agentRun={MANUAL_AGENT_RUN}
          events={TRANSCRIPT_EVENTS}
          eventsLoading={false}
          eventsError={null}
          onClose={() => {}}
          onViewIssue={() => {}}
          onStatusAction={() => {}}
          updatingIncident={false}
          summaryTelemetry={
            <div className="pt-1">
              <MetaLabel>Cited telemetry</MetaLabel>
              <div className="mt-2">
                <CitedWidget title="Pool saturation" badge="20/20" rows={POOL_ROWS} />
              </div>
            </div>
          }
          transcript={
            <div className="mt-8">
              <CollapsibleTranscript />
            </div>
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// buckets are "YYYY-MM-DD HH:MM:SS" UTC strings, spaced `stepMin` apart, which is
// what the chart axis formatter (fmtBucketTime) expects.
function buckets(count: number, stepMin = 2): string[] {
  const start = Date.UTC(2026, 5, 26, 13, 10, 0);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start + i * stepMin * 60_000);
    return d.toISOString().slice(0, 19).replace("T", " ");
  });
}

function seriesOf(group: string, values: number[]): MetricSeriesRow[] {
  const b = buckets(values.length);
  return values.map((value, i) => ({ bucket: b[i]!, group, value }));
}

// Series anchored to a fixed UTC start (used by the reconstructed-incident surface).
function seriesFrom(
  group: string,
  startUTC: string,
  stepMin: number,
  values: number[],
): MetricSeriesRow[] {
  const start = Date.parse(startUTC);
  return values.map((value, i) => ({
    bucket: new Date(start + i * stepMin * 60_000).toISOString().slice(0, 19).replace("T", " "),
    group,
    value,
  }));
}

// Real data from agent run amber-koala: the cumulative counter is 0 until the
// two failures at 02:51, then pinned at 2 (re-exported every 5 s) for the rest.
const SIGNIN_ROWS = seriesFrom(
  "auth.signin.failures",
  "2026-06-26T02:45:00Z",
  1,
  [0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
);

// The four real POST /api/auth/events beacon spans at ~02:51 (from the trace query).
const REAL_TRACES = [
  {
    timestamp: "2026-06-26 02:51:07",
    service: "core-platform",
    span_name: "POST /api/auth/events",
    status_code: "STATUS_CODE_UNSET",
    duration_ms: 41,
    trace_id: "ffadbe50b415365b82b54613751acd12",
  },
  {
    timestamp: "2026-06-26 02:51:16",
    service: "core-platform",
    span_name: "POST /api/auth/events",
    status_code: "STATUS_CODE_UNSET",
    duration_ms: 36,
    trace_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  },
  {
    timestamp: "2026-06-26 02:51:26",
    service: "core-platform",
    span_name: "POST /api/auth/events",
    status_code: "STATUS_CODE_UNSET",
    duration_ms: 44,
    trace_id: "0192837465afbecd0192837465afbecd",
  },
  {
    timestamp: "2026-06-26 02:51:34",
    service: "core-platform",
    span_name: "POST /api/auth/events",
    status_code: "STATUS_CODE_UNSET",
    duration_ms: 39,
    trace_id: "deadbeefcafef00ddeadbeefcafef00d",
  },
];

// The agent's actual edit to lib/metrics/booking-metrics.ts, condensed.
const REAL_DIFF: DiffLine[] = [
  {
    t: "del",
    text: "import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'",
  },
  {
    t: "add",
    text: "import { OTLPMetricExporter, AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http'",
  },
  { t: "ctx", text: "const exporter = new OTLPMetricExporter({" },
  { t: "add", text: "  temporalityPreference: AggregationTemporalityPreference.DELTA," },
  { t: "ctx", text: "});" },
  { t: "del", text: "  exportIntervalMillis: 5000, // Faster export for testing" },
  { t: "add", text: "  exportIntervalMillis: 60_000," },
];

// Example incident fixtures for the reconstructed-transcript surface.
const REAL_INCIDENT: Incident = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: "11111111-1111-4111-8111-111111111111",
  service: "core-platform",
  environment: "prod",
  title: "auth.signin.failures alert fires false positives from CUMULATIVE metric re-export",
  codename: "amber-koala",
  severity: "SEV-3",
  status: "open",
  noiseReason: null,
  noiseResolvedAt: null,
  firstSeen: ago(255),
  lastSeen: ago(248),
  issueCount: 0,
  slackChannelId: null,
  slackThreadTs: null,
  agentSummary:
    "The auth.signin.failures alert fired as a false positive due to OTel's CUMULATIVE metric temporality combined with a test-only 5-second export interval. Two real signin failures at ~02:51 UTC set the counter to 2, which was then re-exported every 5 seconds — causing the alert to count 62 “failures” in a 5-minute window instead of the actual 2.",
  rootCauseText:
    "`OTLPMetricExporter` defaults to CUMULATIVE temporality: once a counter accumulates a value it re-emits that same total on every export tick. With `exportIntervalMillis: 5000` (a dev artifact left in prod), the counter kept emitting `value=2` every 5s. The alert engine sums raw points → 31 exports × 2 = 62 in the 5-minute window, crossing the >20 threshold.",
  rootCauseConfidence: 9,
  estimatedImpactText:
    "auth.signin.failures is the primary signal for detecting credential-stuffing on the signin endpoint. Recurring false positives erode trust and risk alert fatigue on a security-critical signal.",
  estimatedImpactConfidence: 8,
  suggestedSeverity: "SEV-3",
  noiseClassification: null,
  resolutionClassification: null,
  findingsAgentRunId: "33333333-3333-4333-8333-333333333333",
  createdAt: ago(255),
  updatedAt: ago(248),
};

const REAL_AGENT_RUN: AgentRun = {
  id: "33333333-3333-4333-8333-333333333333",
  incidentId: REAL_INCIDENT.id,
  runtime: "anthropic",
  state: "complete",
  providerSessionId: "sess-amber-koala",
  selectedRepoFullName: "acme/web-api",
  selectedRepoUrl: "https://github.com/acme/web-api",
  selectedBaseBranch: "master",
  cumulativeRuntimeMinutes: 4,
  resumeCount: 0,
  startedAt: ago(255),
  completedAt: ago(248),
  failureReason: null,
  result: {
    state: "complete",
    summary: REAL_INCIDENT.agentSummary!,
    proposedTitle: REAL_INCIDENT.title,
    severity: "SEV-3",
    rootCauseConfidence: "high",
    rootCause: { confidence: 9, text: REAL_INCIDENT.rootCauseText! },
    estimatedImpact: { confidence: 8, text: REAL_INCIDENT.estimatedImpactText! },
    pr: {
      selectedRepoFullName: "acme/web-api",
      branchName: "superlog/fix-metrics-delta-temporality",
      baseBranch: "master",
      patch: "diff --git a/lib/metrics/booking-metrics.ts b/lib/metrics/booking-metrics.ts\n",
      validationPassed: true,
      validationCommands: ["npx vitest run app/api/auth/events/route.test.ts"],
      changedFiles: ["lib/metrics/booking-metrics.ts"],
      openStatus: "pending",
      url: null,
    },
  },
  createdAt: ago(255),
  updatedAt: ago(248),
};

// Real amber-koala events in the exact incident_events shape — lifecycle events
// (timeline) plus the agent.* conversation with real tool inputs and recorded
// result JSON. Fed to the real IncidentDetailContent so the shipped data-driven
// transcript renderer (not a hand-authored mock) is what's exercised.
const UMBER_OCELOT_EVENTS: IncidentEvent[] = [
  {
    id: "uo-1",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent_run_queued",
    summary: "Investigation queued from alert auth.signin.failures.",
    detail: null,
    createdAt: ago(256),
  },
  {
    id: "uo-2",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "repo_selected",
    summary: "Selected repo acme/web-api (base branch: master).",
    detail: null,
    createdAt: ago(255),
  },
  {
    id: "uo-3",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.message",
    summary:
      "I'll investigate this production auth signin failure spike. Let me start by querying the telemetry to understand the scope and nature of the incident.",
    detail: null,
    createdAt: ago(255),
  },
  {
    id: "uo-4",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.mcp_tool_use",
    providerEventId: "sevt_metrics",
    summary: "superlog.query_metrics({...})",
    detail: {
      toolUse: {
        name: "query_metrics",
        mcpServerName: "superlog",
        input: {
          metric_name: "auth.signin.failures",
          range: { since: "2026-06-26T02:45:00Z", until: "2026-06-26T03:05:00Z" },
          resource_attrs: [{ key: "deployment.environment.name", value: "prod" }],
          limit: 200,
        },
      },
    },
    createdAt: ago(254),
  },
  {
    id: "uo-5",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.mcp_tool_result",
    detail: { toolResult: { toolUseId: "sevt_metrics", isError: false } },
    summary: JSON.stringify(
      [
        ["02:50:00", 0],
        ["02:51:10", 1],
        ["02:51:20", 2],
        ["02:52:00", 2],
        ["02:54:00", 2],
        ["02:56:00", 2],
        ["02:58:00", 2],
        ["03:00:00", 2],
        ["03:02:00", 2],
        ["03:04:00", 2],
      ].map(([t, v]) => ({
        kind: "sum",
        timestamp: `2026-06-26 ${t}.000000000`,
        metric_name: "auth.signin.failures",
        unit: "1",
        service: "core-platform",
        value: v,
      })),
    ),
    createdAt: ago(254),
  },
  {
    id: "uo-6",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.message",
    summary:
      "The metrics show a very regular pattern — exactly value=2 every 5 seconds for the entire window. That's suspiciously flat for a spike. Let me check the actual auth-event traces.",
    detail: null,
    createdAt: ago(253),
  },
  {
    id: "uo-7",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.mcp_tool_use",
    providerEventId: "sevt_traces",
    summary: "superlog.query_traces({...})",
    detail: {
      toolUse: {
        name: "query_traces",
        mcpServerName: "superlog",
        input: {
          range: { since: "2026-06-26T02:40:00Z", until: "2026-06-26T03:00:00Z" },
          resource_attrs: [{ key: "deployment.environment.name", value: "prod" }],
          span_attrs: [{ key: "http.target", value: "/api/auth/events" }],
          limit: 50,
        },
      },
    },
    createdAt: ago(252),
  },
  {
    id: "uo-8",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.mcp_tool_result",
    detail: { toolResult: { toolUseId: "sevt_traces", isError: false } },
    summary: JSON.stringify([
      {
        timestamp: "2026-06-26 02:51:07.120000000",
        service: "core-platform",
        span_name: "POST /api/auth/events",
        status_code: "STATUS_CODE_UNSET",
        duration_ms: 41,
        trace_id: "ffadbe50b415365b82b54613751acd12",
      },
      {
        timestamp: "2026-06-26 02:51:16.450000000",
        service: "core-platform",
        span_name: "POST /api/auth/events",
        status_code: "STATUS_CODE_UNSET",
        duration_ms: 36,
        trace_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      },
      {
        timestamp: "2026-06-26 02:51:26.980000000",
        service: "core-platform",
        span_name: "POST /api/auth/events",
        status_code: "STATUS_CODE_UNSET",
        duration_ms: 44,
        trace_id: "0192837465afbecd0192837465afbecd",
      },
      {
        timestamp: "2026-06-26 02:51:34.850000000",
        service: "core-platform",
        span_name: "POST /api/auth/events",
        status_code: "STATUS_CODE_UNSET",
        duration_ms: 39,
        trace_id: "deadbeefcafef00ddeadbeefcafef00d",
      },
    ]),
    createdAt: ago(252),
  },
  {
    id: "uo-9",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.tool_use",
    providerEventId: "sevt_grep",
    summary: "grep recordFailureMetric",
    detail: {
      toolUse: { name: "grep", input: { pattern: "recordFailureMetric", path: "/workspace/core" } },
    },
    createdAt: ago(251),
  },
  {
    id: "uo-10",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.tool_result",
    detail: { toolResult: { toolUseId: "sevt_grep", isError: false } },
    summary: "lib/metrics/booking-metrics.ts",
    createdAt: ago(251),
  },
  {
    id: "uo-11",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.message",
    summary:
      "Confirmed. OTLPMetricExporter defaults to CUMULATIVE temporality, so the lifetime total (2) is re-emitted on every 5s tick. The alert sums raw points → 62 “failures” in 5 min from 2 real ones. I'll switch both exporters to DELTA and raise the test-only 5s interval.",
    detail: null,
    createdAt: ago(250),
  },
  {
    id: "uo-12",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.tool_use",
    providerEventId: "sevt_edit",
    summary: "edit lib/metrics/booking-metrics.ts",
    detail: {
      toolUse: {
        name: "edit",
        input: {
          file_path: "lib/metrics/booking-metrics.ts",
          old_string:
            "    const exporter = new OTLPMetricExporter({\n      url,\n      headers: {},\n    });\n    const metricReader = new PeriodicExportingMetricReader({\n      exporter,\n      exportIntervalMillis: 5000, // Faster export for testing\n    });",
          new_string:
            "    const exporter = new OTLPMetricExporter({\n      url,\n      headers: {},\n      temporalityPreference: AggregationTemporalityPreference.DELTA,\n    });\n    const metricReader = new PeriodicExportingMetricReader({\n      exporter,\n      exportIntervalMillis: 60_000,\n    });",
        },
      },
    },
    createdAt: ago(249),
  },
  {
    id: "uo-13",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.tool_result",
    detail: { toolResult: { toolUseId: "sevt_edit", isError: false } },
    summary: "File updated: lib/metrics/booking-metrics.ts",
    createdAt: ago(249),
  },
  {
    id: "uo-14",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.tool_use",
    providerEventId: "sevt_test",
    summary: "bash npx vitest run app/api/auth/events/route.test.ts",
    detail: {
      toolUse: {
        name: "bash",
        input: { command: "npx vitest run app/api/auth/events/route.test.ts" },
      },
    },
    createdAt: ago(248),
  },
  {
    id: "uo-15",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.tool_result",
    detail: { toolResult: { toolUseId: "sevt_test", isError: false } },
    summary: "✓ app/api/auth/events/route.test.ts (3 tests) — all passed",
    createdAt: ago(248),
  },
  {
    id: "uo-16",
    agentRunId: REAL_AGENT_RUN.id,
    kind: "agent.message",
    summary: "Submitted findings and opened a PR with the DELTA-temporality fix.",
    detail: null,
    createdAt: ago(248),
  },
];

// Relative-past ISO timestamp, so the live relative-time formatter renders
// "4m ago" rather than a negative delta against the wall clock. Declared as a
// function so it hoists above the fixtures that use it.
function ago(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

// 31 buckets @ 2m = the full 13:10–14:10 window. Flat-then-ramp tells the story:
// quiet until ~13:40, then latency climbs, errors trickle in, pool hits its cap.
const LATENCY_ROWS = seriesOf(
  "p95 ms",
  [
    240, 238, 242, 236, 240, 244, 239, 243, 241, 238, 242, 240, 244, 239, 241, 240, 258, 300, 360,
    420, 486, 548, 604, 652, 690, 720, 742, 752, 758, 760, 760,
  ],
);
const ERROR_ROWS = seriesOf(
  "errors",
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 2, 3, 3, 4, 3, 4, 2, 3, 2, 3],
);
const POOL_ROWS = seriesOf(
  "db.pool.in_use",
  [
    9, 10, 9, 11, 10, 12, 11, 13, 12, 11, 13, 12, 14, 13, 15, 14, 16, 17, 18, 19, 20, 20, 20, 20,
    20, 20, 20, 20, 20, 20, 20,
  ],
);

const LOG_ROWS: LogRow[] = [
  {
    timestamp: "2026-06-26 14:02:11",
    service: "checkout",
    severity: "ERROR",
    severity_number: 17,
    body: "QueryTimeoutError: connection acquisition timed out after 5000ms (pool exhausted)",
    trace_id: "0123456789abcdef0123456789abcdef",
    span_id: "fedcba9876543210",
    log_attrs: {},
    resource_attrs: {},
  },
  {
    timestamp: "2026-06-26 13:58:47",
    service: "checkout",
    severity: "ERROR",
    severity_number: 17,
    body: "QueryTimeoutError: connection acquisition timed out after 5000ms (pool exhausted)",
    trace_id: "1123456789abcdef0123456789abcdef",
    span_id: "fedcba9876543211",
    log_attrs: {},
    resource_attrs: {},
  },
  {
    timestamp: "2026-06-26 13:51:02",
    service: "checkout",
    severity: "ERROR",
    severity_number: 17,
    body: "QueryTimeoutError: connection acquisition timed out after 5000ms (pool exhausted)",
    trace_id: "2123456789abcdef0123456789abcdef",
    span_id: "fedcba9876543212",
    log_attrs: {},
    resource_attrs: {},
  },
];

const MANUAL_INCIDENT: Incident = {
  id: "inv-2291",
  projectId: "p1",
  service: "checkout",
  environment: "production",
  title: "Checkout feels slow for some users",
  codename: "ghost-otter",
  severity: null,
  status: "open",
  noiseReason: null,
  noiseResolvedAt: null,
  firstSeen: ago(60),
  lastSeen: ago(4),
  issueCount: 0,
  slackChannelId: null,
  slackThreadTs: null,
  agentSummary:
    "Checkout p95 latency rose +217% over 30 minutes without alerting; root cause is a saturated DB connection pool (20/20 since 13:40).",
  rootCauseText:
    "db.pool.in_use is pinned at the max of 20 since 13:40. Requests queue for a connection — that is the latency, and the overflow times out as QueryTimeoutError.",
  rootCauseConfidence: 9,
  estimatedImpactText: "~4.2% of checkout sessions in the window saw >1.5s response times.",
  estimatedImpactConfidence: 6,
  suggestedSeverity: "SEV-2",
  noiseClassification: null,
  resolutionClassification: null,
  findingsAgentRunId: "run-2291",
  createdAt: ago(60),
  updatedAt: ago(4),
};

const MANUAL_AGENT_RUN: AgentRun = {
  id: "run-2291",
  incidentId: "inv-2291",
  runtime: "anthropic",
  state: "complete",
  providerSessionId: "sess-2291",
  selectedRepoFullName: null,
  selectedRepoUrl: null,
  selectedBaseBranch: null,
  cumulativeRuntimeMinutes: 2,
  resumeCount: 0,
  startedAt: ago(6),
  completedAt: ago(4),
  failureReason: null,
  result: {
    state: "complete",
    summary:
      "Checkout p95 latency rose +217% over 30 minutes without alerting; root cause is a saturated DB connection pool.",
    proposedTitle: "Checkout feels slow for some users",
    severity: "SEV-2",
    rootCauseConfidence: "high",
    rootCause: {
      confidence: 8,
      text: "db.pool.in_use is pinned at 20/20 since 13:40, so checkout requests queue for a connection and the overflow times out.",
    },
    estimatedImpact: {
      confidence: 6,
      text: "~4.2% of checkout sessions in the window saw >1.5s response times. Trending up.",
    },
  },
  createdAt: ago(6),
  updatedAt: ago(4),
};

// Transcript events in the shape the worker persists to incident_events: telemetry
// tool calls carry detail.toolUse = { name, input, mcpServerName: "superlog" }.
const TRANSCRIPT_EVENTS: IncidentEvent[] = [
  {
    id: "ev-1",
    agentRunId: "run-2291",
    kind: "agent_run_queued",
    summary: "Investigation started from a manual prompt.",
    detail: {
      prompt: "Checkout feels slow for some users in the last hour, but no incident fired.",
    },
    createdAt: ago(6),
  },
  {
    id: "ev-2",
    agentRunId: "run-2291",
    kind: "agent.message",
    summary:
      "I'll compare the checkout path against the previous hour — span latency, then error logs, then the database pool.",
    detail: null,
    createdAt: ago(5.6),
  },
  {
    id: "ev-3",
    agentRunId: "run-2291",
    kind: "agent.mcp_tool_use",
    summary: "query_traces · span = POST /checkout · p95 over 13:10–14:10",
    detail: {
      toolUse: {
        name: "query_traces",
        mcpServerName: "superlog",
        input: {
          span_name: "POST /checkout",
          range: { since: "2026-06-26T13:10:00Z", until: "2026-06-26T14:10:00Z" },
        },
      },
    },
    createdAt: ago(5.4),
  },
  {
    id: "ev-4",
    agentRunId: "run-2291",
    kind: "agent.message",
    summary:
      "p95 ramps 240ms → 760ms after 13:40 but stays under the 1s alert threshold — that's why nothing fired.",
    detail: null,
    createdAt: ago(5),
  },
  {
    id: "ev-5",
    agentRunId: "run-2291",
    kind: "agent.mcp_tool_use",
    summary: "query_metrics · db.pool.in_use · max over 13:10–14:10",
    detail: {
      toolUse: {
        name: "query_metrics",
        mcpServerName: "superlog",
        input: {
          metric_name: "db.pool.in_use",
          range: { since: "2026-06-26T13:10:00Z", until: "2026-06-26T14:10:00Z" },
        },
      },
    },
    createdAt: ago(4.6),
  },
  {
    id: "ev-6",
    agentRunId: "run-2291",
    kind: "agent.message",
    summary:
      "Root cause: DB pool saturated at 20/20 since 13:40. Real slow-burn regression below the alert threshold — raise the pool or add a 600ms p95 alert.",
    detail: null,
    createdAt: ago(4),
  },
];

function listRow(
  incident: Incident,
  agentRun: AgentRun | null,
  counts: number[],
  impactedUsers: number,
): IncidentListItem {
  const b = buckets(counts.length, 60 * 24); // daily-ish buckets, only used for the row sparkline
  return {
    incident,
    agentRun,
    windowDays: 14,
    buckets: counts.map((count, i) => ({ day: b[i]!.slice(0, 10), count })),
    impactedUsers,
    impactedUsersAvailable: impactedUsers > 0,
    impactedUsersCapped: false,
    pendingResolutionProposal: null,
  };
}

const LIST_ROWS: IncidentListItem[] = [
  listRow(MANUAL_INCIDENT, MANUAL_AGENT_RUN, [0, 0, 1, 2, 1, 3, 4, 5, 6, 8, 12, 14, 18, 22], 0),
  listRow(
    {
      ...MANUAL_INCIDENT,
      id: "inc-4471",
      title: "Payment webhook returning 500 — Stripe charge confirmations dropped",
      codename: "brave-comet",
      service: "payments-api",
      severity: "SEV-1",
      agentSummary: null,
      rootCauseText: null,
      findingsAgentRunId: null,
    },
    null,
    [1, 1, 2, 2, 3, 18, 24, 22, 25, 23, 26, 24, 27, 25],
    2100,
  ),
  listRow(
    {
      ...MANUAL_INCIDENT,
      id: "inc-4469",
      title: "Elevated p99 on search service after 14:00 deploy",
      codename: "quiet-harbor",
      service: "search",
      severity: "SEV-2",
      agentSummary: null,
      rootCauseText: null,
      findingsAgentRunId: null,
    },
    null,
    [6, 7, 6, 8, 9, 14, 13, 15, 14, 16, 15, 17, 16, 18],
    430,
  ),
];
