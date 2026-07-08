import type { ReactNode } from "react";
import { SkeletonBlock } from "./design/ui.tsx";

export type TelemetrySkeletonSource = "logs" | "traces" | "metrics";

const LIST_ROWS = ["one", "two", "three", "four", "five", "six", "seven"];
const ISSUE_META_CELLS = ["service", "environment", "events", "first-seen", "last-seen"];
const INCIDENT_META_ROWS = [
  "priority",
  "status",
  "service",
  "environment",
  "first-detection",
  "latest-detection",
  "agent-run",
];
const INCIDENT_EVENT_ROWS = ["created", "grouped", "investigated", "updated", "resolved"];
const DETAIL_ROWS = [
  "timestamp",
  "severity",
  "service",
  "trace",
  "span",
  "resource",
  "body",
  "attrs",
];
const METRIC_BARS = [35, 58, 44, 70, 52, 82, 62, 48, 76, 56, 88, 64, 42, 72, 54, 80].map(
  (height, index) => ({ key: `bar-${index}-${height}`, height }),
);

function SkeletonStatus({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: this status region wraps complex loading layouts; output cannot contain this structure.
    <div role="status" aria-label={label} className={className}>
      {children}
    </div>
  );
}

function EntityListSkeleton({
  label,
  rows = 7,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <SkeletonStatus
      label={label}
      className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface"
    >
      {LIST_ROWS.slice(0, rows).map((row) => (
        <div key={`${label}-${row}`} className="px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <SkeletonBlock className="h-5 w-14" />
                <SkeletonBlock className="h-5 w-20" />
                <SkeletonBlock className="h-3 w-28" />
              </div>
              <SkeletonBlock className="h-4 w-4/5" />
              <SkeletonBlock className="h-3 w-2/3" />
            </div>
            <div className="w-24 shrink-0 space-y-2">
              <SkeletonBlock className="ml-auto h-3 w-16" />
              <SkeletonBlock className="ml-auto h-3 w-20" />
            </div>
          </div>
        </div>
      ))}
    </SkeletonStatus>
  );
}

export function IssueListSkeleton() {
  return <EntityListSkeleton label="Loading issues" />;
}

export function IncidentListSkeleton() {
  return <EntityListSkeleton label="Loading incidents" />;
}

export function IssueDetailSkeleton() {
  return (
    <SkeletonStatus label="Loading issue detail" className="space-y-8 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SkeletonBlock className="h-5 w-14" />
          <SkeletonBlock className="h-5 w-2/3" />
        </div>
        <SkeletonBlock className="h-7 w-7" />
      </div>
      <div className="space-y-2">
        <div className="flex gap-2">
          <SkeletonBlock className="h-5 w-20" />
          <SkeletonBlock className="h-5 w-24" />
          <SkeletonBlock className="h-5 w-28" />
        </div>
        <SkeletonBlock className="h-4 w-3/5" />
      </div>
      <div className="space-y-3">
        <SkeletonBlock className="h-4 w-24" />
        <SkeletonBlock className="h-28 w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {ISSUE_META_CELLS.map((cell) => (
          <div
            key={`issue-meta-${cell}`}
            className="space-y-2 border border-border bg-surface-2 p-3"
          >
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-4 w-28" />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <SkeletonBlock className="h-8 w-full" />
        <SkeletonBlock className="h-8 w-full" />
      </div>
    </SkeletonStatus>
  );
}

export function IncidentDetailSkeleton() {
  return (
    <SkeletonStatus label="Loading incident detail" className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
        <SkeletonBlock className="h-4 w-20" />
        <SkeletonBlock className="h-4 w-3/5" />
        <SkeletonBlock className="ml-auto h-7 w-28" />
        <SkeletonBlock className="h-7 w-7" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[390px_minmax(0,1fr)]">
        <aside className="border-b border-border px-7 py-7 lg:border-b-0 lg:border-r">
          <div className="space-y-4">
            <SkeletonBlock className="h-3 w-28" />
            <SkeletonBlock className="h-7 w-4/5" />
            <SkeletonBlock className="h-4 w-full" />
            <SkeletonBlock className="h-4 w-5/6" />
          </div>
          <div className="mt-7 grid gap-3.5">
            {INCIDENT_META_ROWS.map((row) => (
              <div
                key={`incident-meta-${row}`}
                className="grid grid-cols-[132px_minmax(0,1fr)] gap-3"
              >
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="h-4 w-full" />
              </div>
            ))}
          </div>
          <div className="mt-7 grid gap-2">
            <SkeletonBlock className="h-7 w-full" />
            <SkeletonBlock className="h-7 w-full" />
          </div>
        </aside>
        <main className="min-h-0 min-w-0 px-8 py-6">
          <div className="mb-6 flex gap-2">
            <SkeletonBlock className="h-7 w-20" />
            <SkeletonBlock className="h-7 w-20" />
            <SkeletonBlock className="h-7 w-14" />
          </div>
          <div className="space-y-4">
            {INCIDENT_EVENT_ROWS.map((row) => (
              <div
                key={`incident-event-${row}`}
                className="rounded-lg border border-border bg-surface p-4"
              >
                <SkeletonBlock className="h-4 w-2/3" />
                <SkeletonBlock className="mt-3 h-3 w-full" />
                <SkeletonBlock className="mt-2 h-3 w-5/6" />
              </div>
            ))}
          </div>
        </main>
      </div>
    </SkeletonStatus>
  );
}

export function ExploreSignalListSkeleton({ source }: { source: TelemetrySkeletonSource }) {
  const columns =
    source === "logs"
      ? [
          { key: "timestamp", width: "w-32" },
          { key: "service", width: "w-24" },
          { key: "severity", width: "w-12" },
          { key: "body", width: "w-full" },
        ]
      : source === "traces"
        ? [
            { key: "timestamp", width: "w-32" },
            { key: "service", width: "w-24" },
            { key: "span", width: "w-full" },
            { key: "status", width: "w-16" },
            { key: "duration", width: "w-14" },
          ]
        : [
            { key: "timestamp", width: "w-32" },
            { key: "metric", width: "w-full" },
            { key: "kind", width: "w-16" },
            { key: "service", width: "w-24" },
            { key: "value", width: "w-20" },
            { key: "unit", width: "w-12" },
          ];
  const gridStyle = { gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` };
  return (
    <SkeletonStatus label={`Loading ${source}`} className="min-w-[720px]">
      <div className="grid gap-4 px-5 py-2" style={gridStyle}>
        {columns.map((column) => (
          <SkeletonBlock key={`${source}-head-${column.key}`} className={`h-3 ${column.width}`} />
        ))}
      </div>
      <div className="divide-y divide-border border-t border-border">
        {LIST_ROWS.map((row) => (
          <div key={`${source}-row-${row}`} className="grid gap-4 px-5 py-3" style={gridStyle}>
            {columns.map((column, col) => (
              <SkeletonBlock
                key={`${source}-cell-${row}-${column.key}`}
                className={`h-4 ${col === columns.length - 1 ? "w-full" : column.width}`}
              />
            ))}
          </div>
        ))}
      </div>
    </SkeletonStatus>
  );
}

export function ExploreSignalDetailSkeleton({ source }: { source: TelemetrySkeletonSource }) {
  return (
    <SkeletonStatus
      label={`Loading ${source} detail`}
      className="flex h-full flex-col gap-6 px-6 py-6"
    >
      <div className="space-y-2">
        <SkeletonBlock className="h-3 w-20" />
        <SkeletonBlock className="h-5 w-2/3" />
      </div>
      <SkeletonBlock className="h-36 w-full" />
      <div className="grid gap-2">
        {DETAIL_ROWS.map((row) => (
          <div
            key={`${source}-detail-${row}`}
            className="grid grid-cols-[160px_minmax(0,1fr)] gap-3"
          >
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-4 w-full" />
          </div>
        ))}
      </div>
    </SkeletonStatus>
  );
}

export function MetricDetailSkeleton() {
  return (
    <SkeletonStatus label="Loading metric detail" className="flex h-48 items-end gap-2 px-2 pb-2">
      {METRIC_BARS.map((bar) => (
        <SkeletonBlock key={bar.key} className="flex-1" style={{ height: `${bar.height}%` }} />
      ))}
    </SkeletonStatus>
  );
}
