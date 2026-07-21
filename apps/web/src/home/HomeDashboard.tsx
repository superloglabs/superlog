import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { type Layout, type LayoutItem, useContainerWidth } from "react-grid-layout";
import { verticalCompactor } from "react-grid-layout";
import { type ExploreRange, useCloudConnections } from "../api.ts";
import { WidgetForm } from "../dashboards/WidgetForm.tsx";
import {
  type HomeBuiltinType,
  useCreateHomeLink,
  useCreateHomeWidget,
  useDeleteHomeItem,
  useHomeDashboard,
  useSetHomeBuiltin,
  useUpdateHomeLayout,
} from "../dashboards/api.ts";
import type { Widget, WidgetLayout } from "../dashboards/types.ts";
import { defaultLayoutFor } from "../dashboards/types.ts";
import { emptyWidgetForm } from "../dashboards/widget-config.ts";
import { WidgetBody } from "../dashboards/widgets/WidgetBody.tsx";
import {
  RANGE_PRESETS,
  RangePicker,
  type RangeSelection,
  rangeFromSeconds,
} from "../design/RangePicker.tsx";
import { Btn, Input, PageHeader } from "../design/ui.tsx";
import { SetupTodos } from "../onboarding/SetupTodos.tsx";
import type { ProjectRouteSlugs } from "../project-route.ts";
import { ActiveIncidentsHomeWidget, ServiceMapHomeWidget } from "./BuiltinHomeWidgets.tsx";
import { HomeCustomizePanel } from "./HomeCustomizePanel.tsx";
import {
  AgentPullRequestsHomeWidget,
  IncidentCountHomeWidget,
  IncomingSignalsHomeWidget,
} from "./HomePulseWidgets.tsx";
import { homeWidgetMinWidth, homeWidgetPresentation, splitHomeWidgets } from "./home-layout.ts";

const GRID_CONFIG = {
  cols: 12,
  rowHeight: 56,
  margin: [16, 16] as [number, number],
  containerPadding: [0, 0] as [number, number],
};
const DEFAULT_RANGE: RangeSelection = { seconds: 3 * 60 * 60, label: "Last 3h" };
const BUILTIN_TYPES = new Set<HomeBuiltinType>([
  "setup_todos",
  "active_incidents",
  "service_map",
  "incoming_signals",
  "incident_count",
  "agent_pull_requests",
]);

export function HomeDashboard({
  projectId,
  slugs,
}: {
  projectId: string;
  slugs: ProjectRouteSlugs;
}) {
  const home = useHomeDashboard(projectId);
  const cloudConnections = useCloudConnections(projectId);
  const setBuiltin = useSetHomeBuiltin(projectId);
  const updateLayout = useUpdateHomeLayout(projectId);
  const remove = useDeleteHomeItem(projectId);
  const [customizing, setCustomizing] = useState(false);
  const [addingWidget, setAddingWidget] = useState(false);
  const [addingLink, setAddingLink] = useState(false);
  const [selection, setSelection] = useState<RangeSelection>(
    RANGE_PRESETS.find((preset) => preset.seconds === DEFAULT_RANGE.seconds) ?? DEFAULT_RANGE,
  );
  const [nowTick, setNowTick] = useState(() => Date.now());
  const range = useMemo(() => rangeFromSeconds(selection.seconds, nowTick), [selection, nowTick]);

  if (home.isLoading) return <div className="text-[12px] text-muted">Loading home…</div>;
  if (home.error || !home.data) {
    return <div className="text-[12px] text-danger">Failed to load home.</div>;
  }

  const enabledBuiltins = home.data.widgets
    .map((widget) => widget.type)
    .filter((type): type is HomeBuiltinType => BUILTIN_TYPES.has(type as HomeBuiltinType));
  const { setup, grid } = splitHomeWidgets(home.data.widgets);
  // Hide the service map tile for projects that have no cloud connection — without
  // one there's no map and nothing to build, so the widget is pure clutter. Only
  // hide once the connections query has actually resolved to an empty list: while
  // it's still loading or if it errored, keep the tile so a connected project's map
  // doesn't flicker away (or stay hidden on a transient failure). Also keep it while
  // customizing so it stays draggable/removable.
  const hideServiceMap =
    cloudConnections.isSuccess && (cloudConnections.data?.length ?? 0) === 0 && !customizing;
  const visibleGrid = grid.filter((widget) => widget.type !== "service_map" || !hideServiceMap);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description="Project health, critical activity, and the signals your team returns to every day."
        actions={
          <>
            <RangePicker
              value={selection}
              range={range}
              onChange={(next) => {
                setSelection(next);
                setNowTick(Date.now());
              }}
            />
            <Btn variant="secondary" onClick={() => setCustomizing(true)}>
              Customize home
            </Btn>
          </>
        }
      />

      {setup && <SetupTodos projectId={projectId} />}

      {home.data.widgets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong py-16 text-center">
          <div className="text-[13px] text-muted">Your home is empty.</div>
          <Btn className="mt-4" variant="secondary" onClick={() => setCustomizing(true)}>
            Add your first widget
          </Btn>
        </div>
      ) : visibleGrid.length > 0 ? (
        <HomeGrid
          projectId={projectId}
          slugs={slugs}
          range={range}
          widgets={visibleGrid}
          customizing={customizing}
          onRemove={(widget) => {
            if (confirm(`Remove “${widget.title}” from home?`)) remove.mutate(widget.id);
          }}
          onLayoutChange={(widgets) => updateLayout.mutate(widgets)}
        />
      ) : null}

      {customizing && (
        <HomeCustomizePanel
          enabledBuiltins={enabledBuiltins}
          onToggleBuiltin={(type, enabled) => setBuiltin.mutate({ type, enabled })}
          onAddWidget={() => setAddingWidget(true)}
          onAddLink={() => setAddingLink(true)}
          onDone={() => setCustomizing(false)}
        />
      )}
      {addingWidget && (
        <HomeAddWidget projectId={projectId} range={range} onClose={() => setAddingWidget(false)} />
      )}
      {addingLink && (
        <AddHomeLinkDialog projectId={projectId} onClose={() => setAddingLink(false)} />
      )}
    </div>
  );
}

function HomeGrid({
  projectId,
  slugs,
  range,
  widgets,
  customizing,
  onRemove,
  onLayoutChange,
}: {
  projectId: string;
  slugs: ProjectRouteSlugs;
  range: ExploreRange;
  widgets: Widget[];
  customizing: boolean;
  onRemove: (widget: Widget) => void;
  onLayoutChange: (widgets: { id: string; layout: WidgetLayout }[]) => void;
}) {
  const { width, containerRef, mounted } = useContainerWidth();
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;

  useEffect(
    () => () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    },
    [],
  );

  const layout: Layout = useMemo(
    () =>
      widgets.map((widget) => ({
        i: widget.id,
        ...widget.layout,
        minW: homeWidgetMinWidth(widget.type),
        minH: widget.type === "link" ? 2 : 3,
      })),
    [widgets],
  );

  const handleLayoutChange = useCallback(
    (next: Layout) => {
      if (!customizing) return;
      const current = new Map(widgetsRef.current.map((widget) => [widget.id, widget.layout]));
      const changed: { id: string; layout: WidgetLayout }[] = [];
      for (const item of next as LayoutItem[]) {
        const previous = current.get(item.i);
        if (!previous) continue;
        if (
          previous.x !== item.x ||
          previous.y !== item.y ||
          previous.w !== item.w ||
          previous.h !== item.h
        ) {
          changed.push({ id: item.i, layout: { x: item.x, y: item.y, w: item.w, h: item.h } });
        }
      }
      if (changed.length === 0) return;
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(() => onLayoutChange(changed), 400);
    },
    [customizing, onLayoutChange],
  );

  return (
    <div ref={containerRef}>
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={GRID_CONFIG}
          dragConfig={{ enabled: customizing, handle: ".home-widget-handle" }}
          resizeConfig={{ enabled: customizing }}
          compactor={verticalCompactor}
          onLayoutChange={handleLayoutChange}
        >
          {widgets.map((widget) => (
            <div key={widget.id}>
              <HomeItemTile
                projectId={projectId}
                slugs={slugs}
                range={range}
                widget={widget}
                customizing={customizing}
                onRemove={() => onRemove(widget)}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}

function HomeItemTile({
  projectId,
  slugs,
  range,
  widget,
  customizing,
  onRemove,
}: {
  projectId: string;
  slugs: ProjectRouteSlugs;
  range: ExploreRange;
  widget: Widget;
  customizing: boolean;
  onRemove: () => void;
}) {
  const presentation = homeWidgetPresentation(widget.type);
  return (
    <section
      className={`flex h-full flex-col overflow-hidden rounded-xl border bg-surface ${
        customizing ? "border-accent/50" : "border-border"
      }`}
    >
      <div className="home-widget-handle flex min-h-11 items-center justify-between gap-3 border-b border-border px-4">
        <h2 className="truncate text-[13px] font-medium text-fg">{widget.title}</h2>
        {customizing && (
          <button
            type="button"
            onClick={onRemove}
            onMouseDown={(event) => event.stopPropagation()}
            className="text-[11px] text-subtle hover:text-danger"
          >
            Remove
          </button>
        )}
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${presentation.bodyPadding ? "p-4" : ""}`}>
        <HomeItemBody projectId={projectId} slugs={slugs} range={range} widget={widget} />
      </div>
    </section>
  );
}

function HomeItemBody({
  projectId,
  slugs,
  range,
  widget,
}: {
  projectId: string;
  slugs: ProjectRouteSlugs;
  range: ExploreRange;
  widget: Widget;
}) {
  switch (widget.type) {
    case "setup_todos":
      return <SetupTodos projectId={projectId} />;
    case "active_incidents":
      return <ActiveIncidentsHomeWidget projectId={projectId} slugs={slugs} />;
    case "service_map":
      return <ServiceMapHomeWidget projectId={projectId} />;
    case "incoming_signals":
      return <IncomingSignalsHomeWidget projectId={projectId} range={range} />;
    case "incident_count":
      return <IncidentCountHomeWidget projectId={projectId} />;
    case "agent_pull_requests":
      return <AgentPullRequestsHomeWidget projectId={projectId} />;
    case "link":
      return <HomeLink widget={widget} />;
    default:
      return <WidgetBody projectId={projectId} range={range} widget={widget} />;
  }
}

function HomeLink({ widget }: { widget: Widget }) {
  const url = widget.config.url;
  if (!url) return <div className="text-[11px] text-danger">This link has no URL.</div>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex h-full min-h-16 flex-col justify-between rounded-lg p-1 text-fg hover:text-accent"
    >
      <p className="text-[11px] leading-4 text-muted">{widget.config.description ?? url}</p>
      <span className="mt-3 text-[12px] font-medium">Open link ↗</span>
    </a>
  );
}

function HomeAddWidget({
  projectId,
  range,
  onClose,
}: {
  projectId: string;
  range: ExploreRange;
  onClose: () => void;
}) {
  const create = useCreateHomeWidget(projectId);
  return (
    <WidgetForm
      projectId={projectId}
      range={range}
      mode="create"
      initial={emptyWidgetForm()}
      variables={[]}
      submitting={create.isPending}
      onClose={onClose}
      onSubmit={async ({ type, config, title }) => {
        await create.mutateAsync({ type, title, config, layout: defaultLayoutFor(type) });
        onClose();
      }}
    />
  );
}

function AddHomeLinkDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const create = useCreateHomeLink(projectId);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");

  return (
    <Dialog title="Add link" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create
            .mutateAsync({
              title: title.trim(),
              url: url.trim(),
              description: description.trim() || undefined,
            })
            .then(onClose);
        }}
      >
        <Field label="Title">
          <Input required value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="URL">
          <Input
            required
            type="url"
            placeholder="https://…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label="Description">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional context for your team"
          />
        </Field>
        {create.error && <div className="text-[11px] text-danger">{String(create.error)}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn type="submit" loading={create.isPending} disabled={!title.trim() || !url.trim()}>
            Add link
          </Btn>
        </div>
      </form>
    </Dialog>
  );
}

function Dialog({
  title,
  children,
  onClose,
}: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="presentation">
      {/* biome-ignore lint/a11y/useSemanticElements: this controlled overlay intentionally avoids native dialog top-layer behavior */}
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="text-muted hover:text-fg"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: every caller passes its form control as children
    <label className="block">
      <span className="mb-2 block text-[11px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
