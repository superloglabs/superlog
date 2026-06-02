import { useEffect, useMemo, useState } from "react";
import { AddFilter, MetricNamePicker, SegmentedToggle } from "../Explore.tsx";
import { type ExploreRange, type ResourceAttr, useExploreAttributeKeys } from "../api.ts";
import { Btn, Chip, FieldLabel, Label, Tile } from "../design/ui.tsx";
import { Input } from "../design/ui.tsx";
import { useCreateWidget } from "./api.ts";
import {
  type ChartType,
  type Widget,
  type WidgetType,
  defaultChartType,
  defaultLayoutFor,
} from "./types.ts";
import { WidgetBody } from "./widgets/WidgetBody.tsx";

type Kind = "chart" | "table" | "note";
type DataSource = "metric" | "traces" | "logs";

function widgetTypeFor(kind: Kind, source: DataSource): WidgetType {
  if (kind === "note") return "markdown";
  if (kind === "chart") {
    if (source === "metric") return "timeseries_metric";
    return "timeseries_count";
  }
  return source === "traces" ? "trace_table" : "log_table";
}

function generateTitle({
  kind,
  source,
  metricName,
  groupBy,
  attrs,
  markdown,
}: {
  kind: Kind;
  source: DataSource;
  metricName: string;
  groupBy: string;
  attrs: ResourceAttr[];
  markdown: string;
}): string {
  if (kind === "note") {
    const firstHeading = markdown
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "));
    return firstHeading ? firstHeading.replace(/^#+\s+/, "").slice(0, 80) : "markdown note";
  }
  if (kind === "chart") {
    if (source === "metric") {
      const base = metricName || "metric";
      return groupBy ? `${base} by ${groupBy}` : base;
    }
    if (groupBy) return `${source} by ${groupBy}`;
    return `${source} over time`;
  }
  const base = source === "traces" ? "recent traces" : "recent logs";
  if (attrs.length === 0) return base;
  const first = attrs[0];
  if (!first) return base;
  return `${source} · ${first.key}=${first.value}${attrs.length > 1 ? ` +${attrs.length - 1}` : ""}`;
}

export function AddWidget({
  projectId,
  dashboardId,
  range,
  onClose,
}: {
  projectId: string;
  dashboardId: string;
  range: ExploreRange;
  onClose: () => void;
}) {
  const create = useCreateWidget(projectId, dashboardId);

  const [kind, setKind] = useState<Kind>("chart");
  const [source, setSource] = useState<DataSource>("logs");
  const [metricName, setMetricName] = useState("");
  const [groupBy, setGroupBy] = useState("");
  const [limit, setLimit] = useState(50);
  const [seriesLimit, setSeriesLimit] = useState(10);
  const [attrs, setAttrs] = useState<ResourceAttr[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [chartType, setChartType] = useState<ChartType | undefined>(undefined);
  const [markdown, setMarkdown] = useState(
    "# Note\n\nWrite markdown here. Use bullets, **bold**, and `inline code`.",
  );

  // tables can't show metrics — bounce back to logs if user switches to table
  useEffect(() => {
    if (kind === "table" && source === "metric") setSource("logs");
  }, [kind, source]);

  const keys = useExploreAttributeKeys(projectId, range);

  const type = widgetTypeFor(kind, source);
  const isMetric = kind === "chart" && source === "metric";
  const isCountChart = type === "timeseries_count";
  const isTable = kind === "table";
  const isNote = kind === "note";
  const supportsGroupBy = kind === "chart";

  const title = useMemo(
    () => generateTitle({ kind, source, metricName, groupBy, attrs, markdown }),
    [kind, source, metricName, groupBy, attrs, markdown],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const previewWidget = useMemo<Widget>(
    () => ({
      id: "__preview__",
      dashboardId,
      type,
      title,
      config: {
        source: type === "timeseries_count" ? (source as "logs" | "traces") : undefined,
        filter: { resourceAttrs: attrs.length ? attrs : undefined },
        groupBy: supportsGroupBy && groupBy ? groupBy : undefined,
        metricName: isMetric ? metricName : undefined,
        limit: isTable ? limit : isCountChart && groupBy ? seriesLimit : undefined,
        chartType: kind === "chart" ? chartType : undefined,
        markdown: isNote ? markdown : undefined,
      },
      layout: defaultLayoutFor(type),
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    [
      dashboardId,
      type,
      title,
      source,
      attrs,
      groupBy,
      metricName,
      limit,
      seriesLimit,
      supportsGroupBy,
      isMetric,
      isCountChart,
      isTable,
      isNote,
      kind,
      chartType,
      markdown,
    ],
  );

  const submit = async () => {
    if (isMetric && !metricName) return;
    if (isNote && !markdown.trim()) return;
    await create.mutateAsync({
      type,
      title,
      config: previewWidget.config,
      layout: defaultLayoutFor(type),
    });
    onClose();
  };

  const sourceOptions =
    kind === "chart"
      ? [
          { value: "metric", label: "metric" },
          { value: "traces", label: "traces" },
          { value: "logs", label: "logs" },
        ]
      : [
          { value: "traces", label: "traces" },
          { value: "logs", label: "logs" },
        ];

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg/70 px-4 py-12 backdrop-blur-md"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClose();
      }}
    >
      <div
        role="presentation"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl"
      >
        <Tile className="bg-bg shadow-2xl">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <Label>add widget</Label>
              <div className="mt-1 text-[18px] font-medium text-fg">{title}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle hover:text-fg"
            >
              close
            </button>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <FieldLabel>kind</FieldLabel>
              <SegmentedToggle
                value={kind}
                options={[
                  { value: "chart", label: "chart" },
                  { value: "table", label: "table" },
                  { value: "note", label: "note" },
                ]}
                onChange={(v) => setKind(v as Kind)}
              />
            </div>

            {!isNote && (
              <div>
                <FieldLabel>source</FieldLabel>
                <SegmentedToggle
                  value={source}
                  options={sourceOptions}
                  onChange={(v) => setSource(v as DataSource)}
                />
              </div>
            )}

            {kind === "chart" && (
              <div>
                <FieldLabel>chart type</FieldLabel>
                <SegmentedToggle
                  value={chartType ?? defaultChartType(type)}
                  options={[
                    { value: "line", label: "line" },
                    { value: "bar", label: "bar" },
                  ]}
                  onChange={(v) => setChartType(v as ChartType)}
                />
              </div>
            )}

            {isMetric && (
              <div>
                <FieldLabel>metric</FieldLabel>
                <MetricNamePicker
                  projectId={projectId}
                  range={range}
                  value={metricName}
                  onChange={setMetricName}
                />
              </div>
            )}

            {supportsGroupBy && (
              <div>
                <FieldLabel>group by</FieldLabel>
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                  className="h-8 w-full appearance-none rounded-sm border border-border bg-surface-2 pl-2.5 pr-7 font-mono text-[12px] text-fg focus:border-border-strong focus:outline-none"
                >
                  <option value="">none</option>
                  <option value="service.name">service.name</option>
                  {keys.data
                    ?.filter((k) => k.key !== "service.name")
                    .map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.key}
                      </option>
                    ))}
                </select>
              </div>
            )}

            {isCountChart && groupBy && (
              <div>
                <FieldLabel>top series</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={seriesLimit}
                  onChange={(e) =>
                    setSeriesLimit(Math.max(1, Math.min(50, Number(e.target.value) || 10)))
                  }
                />
                <div className="mt-1 font-mono text-[10px] text-subtle">
                  remaining groups roll into “Other”
                </div>
              </div>
            )}

            {isTable && (
              <div>
                <FieldLabel>row limit</FieldLabel>
                <Input
                  type="number"
                  min={10}
                  max={500}
                  step={10}
                  value={limit}
                  onChange={(e) =>
                    setLimit(Math.max(10, Math.min(500, Number(e.target.value) || 50)))
                  }
                />
              </div>
            )}

            {isNote && (
              <div>
                <FieldLabel>markdown</FieldLabel>
                <textarea
                  value={markdown}
                  onChange={(e) => setMarkdown(e.target.value)}
                  className="min-h-40 w-full resize-y rounded-sm border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
                />
              </div>
            )}

            {!isNote && (
              <div>
                <FieldLabel>filters</FieldLabel>
                <div className="flex flex-wrap items-center gap-2">
                  {attrs.map((a, i) => (
                    <button
                      type="button"
                      key={`${a.key}=${a.value}-${i}`}
                      onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}
                      title="remove"
                    >
                      <Chip tone="accent">
                        <span className="opacity-70">{a.key}</span>
                        <span>=</span>
                        <span>{a.value}</span>
                        <span className="ml-1 opacity-60">×</span>
                      </Chip>
                    </button>
                  ))}
                  <div className="relative">
                    <Btn variant="secondary" size="sm" onClick={() => setFilterOpen((v) => !v)}>
                      + add filter
                    </Btn>
                    {filterOpen && (
                      <AddFilter
                        projectId={projectId}
                        range={range}
                        existing={attrs}
                        onClose={() => setFilterOpen(false)}
                        onPick={(f) => {
                          if (f.kind === "attr") {
                            setAttrs([...attrs, { key: f.key, value: f.value }]);
                          }
                          setFilterOpen(false);
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <Label>preview</Label>
            <div className="mt-3 h-[260px] border border-border bg-surface-1 p-4">
              {isMetric && !metricName ? (
                <div className="flex h-full items-center justify-center font-mono text-[11px] text-subtle">
                  pick a metric to preview
                </div>
              ) : isNote && !markdown.trim() ? (
                <div className="flex h-full items-center justify-center font-mono text-[11px] text-subtle">
                  write a note to preview
                </div>
              ) : (
                <WidgetBody projectId={projectId} range={range} widget={previewWidget} />
              )}
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-3 border-t border-border pt-4">
            <Btn variant="ghost" onClick={onClose}>
              cancel
            </Btn>
            <Btn
              onClick={submit}
              loading={create.isPending}
              disabled={(isMetric && !metricName) || (isNote && !markdown.trim())}
            >
              add widget
            </Btn>
          </div>
        </Tile>
      </div>
    </div>
  );
}
