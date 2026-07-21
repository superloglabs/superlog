import { Area } from "@/components/dither-kit/area";
import { AreaChart } from "@/components/dither-kit/area-chart";
import { Bar } from "@/components/dither-kit/bar";
import { BarChart } from "@/components/dither-kit/bar-chart";
import type { ChartConfig } from "@/components/dither-kit/chart-context";
import { Grid } from "@/components/dither-kit/grid";
import { Legend } from "@/components/dither-kit/legend";
import { Pie } from "@/components/dither-kit/pie";
import { PieChart } from "@/components/dither-kit/pie-chart";
import { Tooltip } from "@/components/dither-kit/tooltip";
import { XAxis } from "@/components/dither-kit/x-axis";
import { YAxis } from "@/components/dither-kit/y-axis";
import type { CSSProperties } from "react";
import {
  type AgentPullRequestSummary,
  type HomeIncidentTrend,
  type HomeSignalSeries,
  useAgentPullRequestSummary,
  useHomeIncidentTrend,
  useHomeSignalSeries,
} from "../dashboards/api.ts";

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const PIXEL_NUMBER_STYLE = {
  fontFamily: '"Geist Pixel", ui-monospace, monospace',
  fontSynthesis: "none",
  WebkitFontSmoothing: "none",
} satisfies CSSProperties;

const SIGNAL_CONFIG = {
  traces: { label: "Traces", color: "green" },
  metrics: { label: "Metrics", color: "orange" },
  logs: { label: "Logs", color: "blue" },
} satisfies ChartConfig;

const INCIDENT_CONFIG = {
  sev1: { label: "SEV-1", color: "red" },
  sev2: { label: "SEV-2", color: "orange" },
  sev3: { label: "SEV-3", color: "blue" },
  untriaged: { label: "Untriaged", color: "grey" },
} satisfies ChartConfig;

const PR_CONFIG = {
  merged: { label: "Merged", color: "green" },
  unmerged: { label: "Not merged", color: "blue" },
} satisfies ChartConfig;

export function IncomingSignalsHomeWidget({
  projectId,
  range,
}: {
  projectId: string;
  range: { since: string; until: string };
}) {
  const series = useHomeSignalSeries(projectId, range);
  if (series.isLoading) return <PulseMessage>Loading signals…</PulseMessage>;
  if (!series.data || series.error) {
    return <PulseMessage tone="danger">Signals unavailable</PulseMessage>;
  }
  return <IncomingSignalsWidgetContent series={series.data} />;
}

export function IncomingSignalsWidgetContent({ series }: { series: HomeSignalSeries }) {
  const signals = [
    {
      label: "Traces",
      value: series.rows.reduce((sum, point) => sum + point.traces, 0),
      dotClass: "bg-success",
    },
    {
      label: "Metrics",
      value: series.rows.reduce((sum, point) => sum + point.metrics, 0),
      dotClass: "bg-warning",
    },
    {
      label: "Logs",
      value: series.rows.reduce((sum, point) => sum + point.logs, 0),
      dotClass: "bg-accent",
    },
  ];

  return (
    <div className="flex h-full min-h-52 flex-col p-4" aria-label="Incoming signals over time">
      <div className="grid min-w-0 grid-cols-3 gap-3">
        {signals.map((signal) => (
          <SignalStat key={signal.label} {...signal} />
        ))}
      </div>

      <div className="mt-4 min-h-0 flex-1">
        <AreaChart
          data={series.rows}
          config={SIGNAL_CONFIG}
          stackType="stacked"
          bloom="aura"
          margins={{ top: 22, right: 6, bottom: 20, left: 34 }}
          animate={false}
        >
          <Grid />
          <XAxis dataKey="bucket" tickFormatter={formatSignalBucket} maxTicks={4} />
          <YAxis tickFormatter={(value) => compactNumber.format(value)} tickCount={3} />
          <Tooltip labelKey="bucket" valueFormatter={(value) => compactNumber.format(value)} />
          <Area dataKey="traces" variant="dotted" />
          <Area dataKey="metrics" variant="gradient" />
          <Area dataKey="logs" variant="hatched" />
        </AreaChart>
      </div>
    </div>
  );
}

function SignalStat({
  label,
  value,
  dotClass,
}: {
  label: string;
  value: number;
  dotClass: string;
}) {
  const formatted = value > 0 ? compactNumber.format(value) : null;
  return (
    <div aria-label={`${label}: ${formatted ?? "no data"}`} className="min-w-0">
      <div
        className="h-9 text-[32px] font-normal leading-9 tracking-[0.02em] text-fg tabular-nums"
        style={PIXEL_NUMBER_STYLE}
      >
        {formatted}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted">
        <span className={`size-1.5 rounded-[1px] ${dotClass}`} aria-hidden="true" />
        {label.toLowerCase()}
      </div>
    </div>
  );
}

export function IncidentCountHomeWidget({ projectId }: { projectId: string }) {
  const trend = useHomeIncidentTrend(projectId);
  if (trend.isLoading) return <PulseMessage>Loading incidents…</PulseMessage>;
  if (!trend.data || trend.error) {
    return <PulseMessage tone="danger">Incidents unavailable</PulseMessage>;
  }
  return <IncidentCountWidgetContent trend={trend.data} />;
}

export function IncidentCountWidgetContent({ trend }: { trend: HomeIncidentTrend }) {
  return (
    <div className="flex h-full min-h-52 flex-col p-4" aria-label="Incidents opened by severity">
      <div aria-label={`${trend.active} active ${trend.active === 1 ? "incident" : "incidents"}`}>
        <div className="flex items-baseline gap-2">
          <span
            className="text-[32px] font-normal leading-none tracking-[0.02em] text-fg tabular-nums"
            style={PIXEL_NUMBER_STYLE}
          >
            {trend.active}
          </span>
          <span className="text-[11px] text-muted">
            active {trend.active === 1 ? "incident" : "incidents"}
          </span>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1">
        <BarChart
          data={trend.rows}
          config={INCIDENT_CONFIG}
          stackType="stacked"
          bloom="aura"
          margins={{ top: 22, right: 6, bottom: 20, left: 24 }}
          animate={false}
        >
          <Grid />
          <XAxis dataKey="label" maxTicks={7} />
          <YAxis tickCount={3} />
          <Legend isClickable />
          <Tooltip labelKey="label" />
          <Bar dataKey="sev1" variant="dotted" />
          <Bar dataKey="sev2" variant="hatched" />
          <Bar dataKey="sev3" variant="gradient" />
          <Bar dataKey="untriaged" variant="solid" />
        </BarChart>
      </div>
    </div>
  );
}

export function AgentPullRequestsHomeWidget({ projectId }: { projectId: string }) {
  const summary = useAgentPullRequestSummary(projectId);
  if (summary.isLoading) return <PulseMessage>Loading pull requests…</PulseMessage>;
  if (!summary.data || summary.error) {
    return <PulseMessage tone="danger">Pull requests unavailable</PulseMessage>;
  }
  return <AgentPullRequestsWidgetContent summary={summary.data} />;
}

export function AgentPullRequestsWidgetContent({ summary }: { summary: AgentPullRequestSummary }) {
  const data = [
    { outcome: "merged", value: summary.merged },
    { outcome: "unmerged", value: summary.unmerged },
  ];

  return (
    <div
      className="grid h-full min-h-52 grid-cols-[minmax(68px,1fr)_minmax(0,3fr)] grid-rows-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 p-4"
      aria-label={`${summary.merged} merged and ${summary.unmerged} not merged`}
    >
      <div className="min-w-0 self-start pt-3">
        <div
          className="text-[32px] font-normal leading-none tracking-[0.02em] text-fg tabular-nums"
          style={PIXEL_NUMBER_STYLE}
        >
          {summary.total}
        </div>
        <div className="mt-2 text-[10px] leading-tight text-muted">pull requests</div>
        <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.08em] text-subtle">
          last 30 days
        </div>
      </div>

      <div className="relative aspect-square h-full max-h-48 w-full max-w-48 place-self-center">
        <PieChart
          data={data}
          config={PR_CONFIG}
          dataKey="value"
          nameKey="outcome"
          innerRadius={0.54}
          bloom="aura"
          animate={false}
          margins={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          <Pie variant="dotted" />
          <Tooltip valueFormatter={(value) => String(value)} />
        </PieChart>
      </div>

      <div className="col-span-2 grid grid-cols-2 gap-x-5 gap-y-2 border-t border-border pt-3">
        <div className="min-w-0">
          <LegendRow color="var(--color-success)" label="Merged" value={summary.merged} />
        </div>
        <div className="min-w-0">
          <LegendRow color="var(--color-accent)" label="Not merged" value={summary.unmerged} />
        </div>
        <div className="col-span-2 flex items-center gap-4 font-mono text-[8px] uppercase tracking-[0.08em] text-subtle">
          <span>{summary.open} open</span>
          <span>{summary.closed} closed</span>
        </div>
      </div>
    </div>
  );
}

function formatSignalBucket(value: unknown): string {
  const normalized = String(value).replace(" ", "T");
  const date = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function LegendRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="flex items-center gap-2 text-muted">
        <span
          className="h-2.5 w-2.5 rounded-[2px]"
          style={{
            backgroundColor: color,
            backgroundImage: "radial-gradient(rgb(var(--color-bg-rgb)) 0.7px, transparent 0.8px)",
            backgroundSize: "3px 3px",
          }}
        />
        {label}
      </span>
      <span className="font-mono text-fg tabular-nums">{value}</span>
    </div>
  );
}

function PulseMessage({
  children,
  tone = "muted",
}: {
  children: string;
  tone?: "muted" | "danger";
}) {
  return (
    <div
      className={`grid h-full min-h-52 place-items-center p-4 text-center text-[11px] ${
        tone === "danger" ? "text-danger" : "text-muted"
      }`}
    >
      {children}
    </div>
  );
}
