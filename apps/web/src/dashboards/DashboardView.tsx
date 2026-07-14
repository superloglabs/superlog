import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { type Layout, type LayoutItem, useContainerWidth } from "react-grid-layout";
import { verticalCompactor } from "react-grid-layout";
import { Link, useParams } from "react-router-dom";
import { useProjectPath } from "../ProjectRouteContext.tsx";
import { type ExploreRange, useMe } from "../api.ts";
import {
  RANGE_PRESETS,
  RangePicker,
  type RangeSelection,
  rangeFromSeconds,
} from "../design/RangePicker.tsx";
import { Btn, Label, Tile } from "../design/ui.tsx";
import { AddWidget } from "./AddWidget.tsx";
import { VariableBar, VariablesManager } from "./Variables.tsx";
import { WidgetForm } from "./WidgetForm.tsx";
import {
  useDashboard,
  useDeleteWidget,
  useRenameDashboard,
  useSetVariables,
  useUpdateLayout,
  useUpdateWidget,
} from "./api.ts";
import type { DashboardVariable, Widget, WidgetLayout } from "./types.ts";
import { VariableValuesProvider } from "./variables-context.tsx";
import { defaultVariableValues } from "./variables.ts";
import { formFromWidget } from "./widget-config.ts";
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
// Stable empty reference so the variable-seeding effect doesn't re-run every
// render while the dashboard is still loading.
const EMPTY_VARIABLES: DashboardVariable[] = [];

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
  const projectPath = useProjectPath();
  const dashboard = useDashboard(projectId, dashboardId);
  const [selection, setSelection] = useState<RangeSelection>(
    RANGE_PRESETS[1] ?? RANGE_PRESETS[0] ?? DEFAULT_RANGE_SELECTION,
  );
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [adding, setAdding] = useState(false);
  const [managingVars, setManagingVars] = useState(false);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const range = useMemo(() => rangeFromSeconds(selection.seconds, nowTick), [selection, nowTick]);
  const setVariables = useSetVariables(projectId, dashboardId);

  const variables: DashboardVariable[] = dashboard.data?.variables ?? EMPTY_VARIABLES;

  // Re-seed selections whenever the variable definitions change: keep the
  // viewer's existing pick when it's still a valid option, otherwise fall back
  // to the default/first option; default newly-added variables and drop removed
  // ones. (A free-form variable — no options — accepts any prior value.)
  useEffect(() => {
    const defaults = defaultVariableValues(variables);
    setVarValues((prev) => {
      const next: Record<string, string> = {};
      for (const v of variables) {
        const prevValue = prev[v.name];
        const prevStillValid =
          prevValue != null && (v.options.length === 0 || v.options.includes(prevValue));
        next[v.name] = prevStillValid ? prevValue : (defaults[v.name] ?? "");
      }
      return next;
    });
  }, [variables]);

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
            to={projectPath("/dashboards")}
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

      <section>
        <VariableBar
          variables={variables}
          values={varValues}
          onChange={(name, value) => setVarValues((prev) => ({ ...prev, [name]: value }))}
          onManage={() => setManagingVars(true)}
          canManage
        />
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
        <VariableValuesProvider value={varValues}>
          <WidgetGrid
            projectId={projectId}
            dashboardId={dashboardId}
            range={range}
            widgets={widgets}
            variables={variables}
          />
        </VariableValuesProvider>
      )}

      {adding && (
        <AddWidget
          projectId={projectId}
          dashboardId={dashboardId}
          range={range}
          variables={variables}
          onClose={() => setAdding(false)}
        />
      )}

      {managingVars && (
        <VariablesManager
          initial={variables}
          saving={setVariables.isPending}
          onSave={async (next) => {
            await setVariables.mutateAsync({ name, variables: next });
          }}
          onClose={() => setManagingVars(false)}
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
  variables,
}: {
  projectId: string;
  dashboardId: string;
  range: ExploreRange;
  widgets: Widget[];
  variables: DashboardVariable[];
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
                variables={variables}
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
  variables,
}: {
  projectId: string;
  dashboardId: string;
  range: ExploreRange;
  widget: Widget;
  variables: DashboardVariable[];
}) {
  const remove = useDeleteWidget(projectId, dashboardId);
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="dashboard-widget-handle flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <EditableWidgetTitle projectId={projectId} dashboardId={dashboardId} widget={widget} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label="widget settings" onClick={() => setEditing(true)}>
            <GearIcon />
          </IconButton>
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
      {editing && (
        <EditWidget
          projectId={projectId}
          dashboardId={dashboardId}
          range={range}
          widget={widget}
          variables={variables}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function EditWidget({
  projectId,
  dashboardId,
  range,
  widget,
  variables,
  onClose,
}: {
  projectId: string;
  dashboardId: string;
  range: ExploreRange;
  widget: Widget;
  variables: DashboardVariable[];
  onClose: () => void;
}) {
  const update = useUpdateWidget(projectId, dashboardId);
  return (
    <WidgetForm
      projectId={projectId}
      range={range}
      mode="edit"
      initial={formFromWidget(widget)}
      existingTitle={widget.title}
      variables={variables}
      submitting={update.isPending}
      onClose={onClose}
      onSubmit={async ({ type, config, title }) => {
        await update.mutateAsync({ id: widget.id, type, title, config });
        onClose();
      }}
    />
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
