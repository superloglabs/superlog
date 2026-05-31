import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { type Layout, type LayoutItem, useContainerWidth } from "react-grid-layout";
import { verticalCompactor } from "react-grid-layout";
import { Link, useParams } from "react-router-dom";
import { AddFilter } from "../Explore.tsx";
import {
  type ExploreRange,
  METRIC_AGGREGATIONS,
  type MetricAggregation,
  type ResourceAttr,
  useMe,
} from "../api.ts";
import {
  RANGE_PRESETS,
  RangePicker,
  type RangeSelection,
  rangeFromSeconds,
} from "../design/RangePicker.tsx";
import { Btn, Label, Tile } from "../design/ui.tsx";
import { AddWidget } from "./AddWidget.tsx";
import {
  useDashboard,
  useDeleteWidget,
  useRenameDashboard,
  useUpdateLayout,
  useUpdateWidget,
} from "./api.ts";
import { type Widget, type WidgetConfig, type WidgetLayout, defaultChartType } from "./types.ts";
import { WidgetBody } from "./widgets/WidgetBody.tsx";

const GRID_COLS = 12;
const ROW_HEIGHT = 60;
const MIN_W: Record<string, number> = {
  timeseries_count: 3,
  timeseries_metric: 3,
  trace_table: 6,
  log_table: 6,
  markdown: 3,
};
const MIN_H = 3;

// Hoisted so <GridLayout> sees stable identity — inline objects re-fire its
// internal onLayoutChange effect every render (React #185 trigger).
const GRID_CONFIG = {
  cols: GRID_COLS,
  rowHeight: ROW_HEIGHT,
  margin: [16, 16] as [number, number],
  containerPadding: [0, 0] as [number, number],
};
const DRAG_CONFIG = { handle: ".dashboard-widget-handle" };
const DEFAULT_RANGE_SELECTION: RangeSelection = { seconds: 60 * 60, label: "Last 1h" };

export function DashboardView() {
  const me = useMe();
  const { id } = useParams<{ id: string }>();

  if (me.isLoading) {
    return (
      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">loading…</div>
    );
  }
  if (me.error || !me.data || !me.data.project) {
    return (
      <div className="font-mono text-[11px] text-danger">
        error: {String(me.error ?? "no session")}
      </div>
    );
  }
  if (!id) {
    return <div className="font-mono text-[11px] text-danger">missing dashboard id</div>;
  }
  return <DashboardViewInner projectId={me.data.project.id} dashboardId={id} />;
}

function DashboardViewInner({
  projectId,
  dashboardId,
}: {
  projectId: string;
  dashboardId: string;
}) {
  const dashboard = useDashboard(projectId, dashboardId);
  const [selection, setSelection] = useState<RangeSelection>(
    RANGE_PRESETS[1] ?? RANGE_PRESETS[0] ?? DEFAULT_RANGE_SELECTION,
  );
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [adding, setAdding] = useState(false);
  const range = useMemo(() => rangeFromSeconds(selection.seconds, nowTick), [selection, nowTick]);

  const applySelection = (next: RangeSelection) => {
    setSelection(next);
    setNowTick(Date.now());
  };

  if (dashboard.isLoading) {
    return (
      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">loading…</div>
    );
  }
  if (dashboard.error || !dashboard.data) {
    return (
      <div className="font-mono text-[11px] text-danger">
        error: {String(dashboard.error ?? "not found")}
      </div>
    );
  }

  const { name, widgets } = dashboard.data;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Link
            to="/dashboards"
            className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
          >
            <span aria-hidden>←</span>
            <span>Back to dashboards</span>
          </Link>
          <EditableTitle projectId={projectId} dashboardId={dashboardId} name={name} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RangePicker value={selection} range={range} onChange={applySelection} />
          <Btn onClick={() => setAdding(true)}>+ add widget</Btn>
        </div>
      </section>

      {widgets.length === 0 ? (
        <Tile>
          <div className="py-12 text-center">
            <div className="font-mono text-[11px] text-subtle">no widgets yet</div>
            <div className="mt-3">
              <Btn variant="secondary" size="sm" onClick={() => setAdding(true)}>
                + add your first widget
              </Btn>
            </div>
          </div>
        </Tile>
      ) : (
        <WidgetGrid
          projectId={projectId}
          dashboardId={dashboardId}
          range={range}
          widgets={widgets}
        />
      )}

      {adding && (
        <AddWidget
          projectId={projectId}
          dashboardId={dashboardId}
          range={range}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function EditableTitle({
  projectId,
  dashboardId,
  name,
}: {
  projectId: string;
  dashboardId: string;
  name: string;
}) {
  const rename = useRenameDashboard(projectId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== name) {
      rename.mutate({ id: dashboardId, name: next });
    } else {
      setDraft(name);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
        className="mt-3 -ml-1 w-full max-w-[640px] rounded-sm border border-border-strong bg-surface-2 px-1 text-[32px] font-semibold tracking-tight text-fg focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="click to rename"
      className="mt-3 -ml-1 block rounded-sm px-1 text-left text-[32px] font-semibold tracking-tight text-fg hover:bg-surface-2"
    >
      {name}
    </button>
  );
}

function EditableWidgetTitle({
  projectId,
  dashboardId,
  widget,
}: {
  projectId: string;
  dashboardId: string;
  widget: Widget;
}) {
  const update = useUpdateWidget(projectId, dashboardId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(widget.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(widget.title);
  }, [widget.title, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== widget.title) {
      update.mutate({ id: widget.id, title: next });
    } else {
      setDraft(widget.title);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(widget.title);
            setEditing(false);
          }
        }}
        className="w-full rounded-sm border border-border-strong bg-surface-2 px-1 text-[14px] font-medium text-fg focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      onMouseDown={(e) => e.stopPropagation()}
      title="click to rename"
      className="block w-full truncate rounded-sm px-1 -mx-1 text-left text-[14px] font-medium text-fg hover:bg-surface-2"
    >
      {widget.title}
    </button>
  );
}

function WidgetGrid({
  projectId,
  dashboardId,
  range,
  widgets,
}: {
  projectId: string;
  dashboardId: string;
  range: ExploreRange;
  widgets: Widget[];
}) {
  // Destructure `mutate` so the callback's dep is stable — the mutation
  // object itself changes identity on every idle→pending→success transition.
  const { mutate: updateLayoutMutate } = useUpdateLayout(projectId, dashboardId);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    };
  }, []);

  const layout: Layout = useMemo(
    () =>
      widgets.map((w) => ({
        i: w.id,
        x: w.layout.x,
        y: w.layout.y,
        w: w.layout.w,
        h: w.layout.h,
        minW: MIN_W[w.type] ?? 3,
        minH: MIN_H,
      })),
    [widgets],
  );

  // Ref so handleLayoutChange below has stable identity across renders.
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;

  const handleLayoutChange = useCallback(
    (next: Layout) => {
      const currentWidgets = widgetsRef.current;
      const byId = new Map(currentWidgets.map((w) => [w.id, w.layout]));
      const changed: { id: string; layout: WidgetLayout }[] = [];
      for (const item of next as LayoutItem[]) {
        const prev = byId.get(item.i);
        if (!prev) continue;
        if (prev.x !== item.x || prev.y !== item.y || prev.w !== item.w || prev.h !== item.h) {
          changed.push({
            id: item.i,
            layout: { x: item.x, y: item.y, w: item.w, h: item.h },
          });
        }
      }
      if (changed.length === 0) return;

      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(() => {
        updateLayoutMutate(changed);
      }, 400);
    },
    [updateLayoutMutate],
  );

  const { width, containerRef, mounted } = useContainerWidth();

  return (
    <div ref={containerRef}>
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={GRID_CONFIG}
          dragConfig={DRAG_CONFIG}
          compactor={verticalCompactor}
          onLayoutChange={handleLayoutChange}
        >
          {widgets.map((w) => (
            <div key={w.id}>
              <WidgetTile
                projectId={projectId}
                dashboardId={dashboardId}
                range={range}
                widget={w}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}

function WidgetTile({
  projectId,
  dashboardId,
  range,
  widget,
}: {
  projectId: string;
  dashboardId: string;
  range: ExploreRange;
  widget: Widget;
}) {
  const remove = useDeleteWidget(projectId, dashboardId);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="dashboard-widget-handle flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <EditableWidgetTitle projectId={projectId} dashboardId={dashboardId} widget={widget} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <WidgetSettingsButton
            projectId={projectId}
            dashboardId={dashboardId}
            range={range}
            widget={widget}
          />
          <IconButton
            label="remove widget"
            onClick={() => {
              if (confirm(`remove widget "${widget.title}"?`)) remove.mutate(widget.id);
            }}
            hoverTone="danger"
          >
            <TrashIcon />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-5">
        <WidgetBody projectId={projectId} range={range} widget={widget} />
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  hoverTone = "fg",
  children,
}: {
  label: string;
  onClick: () => void;
  hoverTone?: "fg" | "danger";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      className={`grid h-7 w-7 place-items-center rounded-sm text-subtle transition-colors ${
        hoverTone === "danger" ? "hover:text-danger" : "hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <title>widget settings</title>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <title>remove widget</title>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function WidgetSettingsButton({
  projectId,
  dashboardId,
  range,
  widget,
}: {
  projectId: string;
  dashboardId: string;
  range: ExploreRange;
  widget: Widget;
}) {
  const update = useUpdateWidget(projectId, dashboardId);
  const [open, setOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const isChart = widget.type === "timeseries_count" || widget.type === "timeseries_metric";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!isChart) return null;

  const setConfig = (patch: Partial<WidgetConfig>) => {
    update.mutate({ id: widget.id, config: { ...widget.config, ...patch } });
  };
  const setResourceAttrs = (resourceAttrs: ResourceAttr[]) => {
    setConfig({
      filter: {
        ...widget.config.filter,
        resourceAttrs: resourceAttrs.length ? resourceAttrs : undefined,
      },
    });
  };
  const updateResourceAttr = (index: number, patch: Partial<ResourceAttr>) => {
    setResourceAttrs(
      (widget.config.filter.resourceAttrs ?? []).map((attr, i) =>
        i === index ? { ...attr, ...patch } : attr,
      ),
    );
  };
  const removeResourceAttr = (index: number) => {
    setResourceAttrs((widget.config.filter.resourceAttrs ?? []).filter((_, i) => i !== index));
  };
  const setAggregation = (aggregation: MetricAggregation | "auto") => {
    const nextConfig = { ...widget.config };
    if (aggregation === "auto") {
      nextConfig.aggregation = undefined;
    } else {
      nextConfig.aggregation = aggregation;
    }
    update.mutate({ id: widget.id, config: nextConfig });
  };

  const chartType = widget.config.chartType ?? defaultChartType(widget.type);
  const showXAxis = widget.config.showXAxis ?? widget.type === "timeseries_count";
  const showYAxis = widget.config.showYAxis ?? false;
  const showLegend = widget.config.showLegend ?? false;
  const aggregation = widget.config.aggregation ?? "auto";
  const resourceAttrs = widget.config.filter.resourceAttrs ?? [];

  return (
    <div ref={ref} className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <IconButton label="widget settings" onClick={() => setOpen((v) => !v)}>
        <GearIcon />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 flex w-80 flex-col gap-3 border border-border bg-bg p-3 font-mono text-[11px] shadow-2xl">
          <div>
            <div className="mb-1 uppercase tracking-[0.2em] text-subtle">chart</div>
            <div className="flex gap-1">
              {(["line", "bar"] as const).map((t) => {
                const active = chartType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setConfig({ chartType: t })}
                    className={`h-7 flex-1 rounded-sm px-2 ${
                      active
                        ? "bg-accent text-accent-ink"
                        : "border border-border text-muted hover:text-fg"
                    }`}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
          {widget.type === "timeseries_metric" && (
            <div>
              <div className="mb-1 uppercase tracking-[0.2em] text-subtle">aggregation</div>
              <div className="grid grid-cols-4 gap-1">
                {(["auto", ...METRIC_AGGREGATIONS] as const).map((a) => {
                  const active = aggregation === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAggregation(a)}
                      className={`h-7 rounded-sm px-2 ${
                        active
                          ? "bg-accent text-accent-ink"
                          : "border border-border text-muted hover:text-fg"
                      }`}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <SettingsToggle
            label="x-axis markers"
            checked={showXAxis}
            onChange={(v) => setConfig({ showXAxis: v })}
          />
          <SettingsToggle
            label="y-axis markers"
            checked={showYAxis}
            onChange={(v) => setConfig({ showYAxis: v })}
          />
          <SettingsToggle
            label="legend"
            checked={showLegend}
            onChange={(v) => setConfig({ showLegend: v })}
          />
          <div>
            <div className="mb-1 uppercase tracking-[0.2em] text-subtle">filters</div>
            <div className="flex flex-col gap-1.5">
              {resourceAttrs.map((attr, i) => (
                <div
                  key={`${attr.key}-${attr.value}-${i}`}
                  className="grid grid-cols-[1fr_7.5rem_1fr_auto] items-center gap-1"
                >
                  <div className="min-w-0 truncate border border-border bg-surface-2 px-2 py-1 text-muted">
                    {attr.key}
                  </div>
                  <select
                    value={attr.op ?? "eq"}
                    onChange={(e) =>
                      updateResourceAttr(i, {
                        op:
                          e.target.value === "eq"
                            ? undefined
                            : (e.target.value as ResourceAttr["op"]),
                      })
                    }
                    className="h-7 rounded-sm border border-border bg-bg px-1 text-[11px] text-muted focus:border-border-strong focus:outline-none"
                  >
                    <option value="eq">is</option>
                    <option value="neq">is not</option>
                    <option value="not_contains">not contains</option>
                  </select>
                  <input
                    value={attr.value}
                    onChange={(e) => updateResourceAttr(i, { value: e.target.value })}
                    className="h-7 min-w-0 rounded-sm border border-border bg-surface-2 px-2 text-[11px] text-muted focus:border-border-strong focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeResourceAttr(i)}
                    className="h-7 w-7 border border-border text-muted hover:text-fg"
                    title="remove filter"
                  >
                    ×
                  </button>
                </div>
              ))}
              {resourceAttrs.length === 0 && <div className="text-subtle">none</div>}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFilterOpen((v) => !v)}
                  className="h-7 w-full border border-border text-muted hover:text-fg"
                >
                  + add filter
                </button>
                {filterOpen && (
                  <AddFilter
                    projectId={projectId}
                    range={range}
                    source={widget.type === "timeseries_count" ? widget.config.source : undefined}
                    existing={resourceAttrs}
                    onClose={() => setFilterOpen(false)}
                    onPick={(f) => {
                      if (f.kind === "attr") {
                        setResourceAttrs([...resourceAttrs, { key: f.key, value: f.value }]);
                      }
                      setFilterOpen(false);
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-muted hover:text-fg">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-accent"
      />
    </label>
  );
}
