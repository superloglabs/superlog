import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LogDrawer } from "./LogDetail.tsx";
import { useProjectPath } from "./ProjectRouteContext.tsx";
import { SavedViewBar } from "./SavedViewBar.tsx";
import { TraceDrawer } from "./TraceDetail.tsx";
import { ExploreFacets, SEVERITY_OPTIONS, STATUS_OPTIONS } from "./ExploreFacets.tsx";
import { facetDisplayName } from "./FacetValues.tsx";
import {
  type CloudResourceRow,
  type ExploreFilter,
  type ExploreRange,
  type LogRow,
  METRIC_AGGREGATIONS,
  type MetricAggregation,
  type MetricName,
  type MetricRow,
  type MetricSeriesRow,
  type ResourceAttr,
  type SeriesRow,
  type TraceAggregatedRow,
  useCloudConnections,
  useCloudResources,
  useExploreAttributeKeys,
  useExploreAttributeValues,
  useExploreLogs,
  useExploreMetricNames,
  useExploreMetricSeries,
  useExploreMetrics,
  useExploreSeries,
  useExploreTraces,
  useExploreTracesAggregated,
  useMe,
  useSyncCloudConnection,
} from "./api.ts";
import { Dropdown } from "./design/Dropdown.tsx";
import { CUSTOM_RANGE_LABEL, parseAbsoluteRange } from "./design/range-url.ts";
import {
  RANGE_PRESETS,
  RangePicker,
  type RangeSelection,
  rangeFromSeconds,
} from "./design/RangePicker.tsx";
import { ScrollArea } from "./design/scroll-area.tsx";
import { Btn, Chip, Input, PageHeader, ShortcutKey, Tile } from "./design/ui.tsx";
import { addAttrFilter } from "./exploreAttrFilter.ts";
import {
  bucketSeriesSpansDates,
  formatBucketAxisTick,
  parseStepMs,
  rangeFromBucketSelection,
} from "./explore-timeseries.ts";
import { sourceFromExplorePath, type ExploreSource } from "./explore-route.ts";
import { tracer } from "./instrumentation.ts";
import {
  buildSavedViewSearchParams,
  captureSavedViewState,
  type SavedExploreViewState,
} from "./saved-view-state.ts";
import {
  ExploreSignalDetailSkeleton,
  ExploreSignalListSkeleton,
  MetricDetailSkeleton,
  type TelemetrySkeletonSource,
} from "./skeletons.tsx";
import { formatLocalHm, formatLocalTimestamp, formatLocalTimestampMs } from "./timeFormat.ts";

const PRESET_STORAGE_KEY = "superlog.explore.range";

// URL-state helpers. Filters/selections live in the URL so a page is shareable
// and the browser back/forward navigation works through filter changes.
function parseAttrParam(s: string): ResourceAttr | null {
  const eq = s.indexOf("=");
  if (eq <= 0) return null;
  return { key: s.slice(0, eq), value: s.slice(eq + 1) };
}

// Stable identifier for a log row. The backend doesn't return a primary key
// so we synthesize one from fields that are unique together within a render
// window. Body is truncated to keep URLs short.
function logRowKey(log: LogRow): string {
  return `${log.timestamp}|${log.service}|${log.body.slice(0, 64)}`;
}

export function Explore() {
  const me = useMe();
  if (me.isLoading) {
    return <div className="font-sans text-[12px] text-muted">Loading…</div>;
  }
  if (me.error || !me.data || !me.data.project) {
    return <div className="text-[12px] text-danger">Error: {String(me.error ?? "no session")}</div>;
  }
  return <ExploreInner projectId={me.data.project.id} />;
}

export type Source = ExploreSource;
type TelemetrySource = TelemetrySkeletonSource;
export type TracesView = "spans" | "traces";

function ExploreInner({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const projectPath = useProjectPath();
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const sourceFromUrl = sourceFromExplorePath(pathname);

  useEffect(() => {
    if (sourceFromUrl === null) {
      navigate(projectPath("/explore/logs"), { replace: true });
    }
  }, [sourceFromUrl, navigate, projectPath]);

  const source: Source = sourceFromUrl ?? "logs";

  const selectedTraceId = searchParams.get("trace");
  const openTrace = useCallback(
    (id: string) => {
      const span = tracer.startSpan("explore.open_trace", {
        attributes: { "trace.id": id, "explore.source": sourceFromUrl ?? "logs" },
      });
      try {
        const next = new URLSearchParams(searchParams);
        next.set("trace", id);
        setSearchParams(next, { replace: false });
      } finally {
        span.end();
      }
    },
    [searchParams, setSearchParams, sourceFromUrl],
  );
  const closeTrace = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("trace");
    setSearchParams(next, { replace: false });
  }, [searchParams, setSearchParams]);

  const relativeRangeSeconds = Number(searchParams.get("range"));
  const relativeRangeLabel = searchParams.get("rangeLabel");
  const validRelativeRangeFromUrl =
    Number.isInteger(relativeRangeSeconds) &&
    relativeRangeSeconds > 0 &&
    relativeRangeSeconds <= 31_536_000 &&
    !!relativeRangeLabel;

  const [selection, setSelection] = useState<RangeSelection>(() => {
    if (validRelativeRangeFromUrl) {
      return { seconds: relativeRangeSeconds, label: relativeRangeLabel };
    }
    try {
      const saved = localStorage.getItem(PRESET_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { seconds?: number; label?: string };
        if (parsed && typeof parsed.seconds === "number" && typeof parsed.label === "string") {
          return { seconds: parsed.seconds, label: parsed.label };
        }
      }
    } catch {
      // ignore — private mode / migration from older `1h` string format
    }
    return RANGE_PRESETS[1]!;
  });
  useEffect(() => {
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(selection));
    } catch {
      // ignore
    }
  }, [selection]);
  useEffect(() => {
    if (!validRelativeRangeFromUrl) return;
    setSelection((current) =>
      current.seconds === relativeRangeSeconds && current.label === relativeRangeLabel
        ? current
        : { seconds: relativeRangeSeconds, label: relativeRangeLabel },
    );
  }, [validRelativeRangeFromUrl, relativeRangeSeconds, relativeRangeLabel]);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Filter/selection state derived from the URL. Updating these writes through
  // setSearchParams so the URL stays a faithful, shareable snapshot of the
  // current view.
  const attrs = useMemo<ResourceAttr[]>(() => {
    const out: ResourceAttr[] = [];
    for (const v of searchParams.getAll("attr")) {
      const a = parseAttrParam(v);
      if (a) out.push(a);
    }
    return out;
  }, [searchParams]);
  const severity = searchParams.get("sev") ?? "";
  const statusCode = searchParams.get("status") ?? "";
  const metricName = searchParams.get("metric") ?? "";
  const groupBy = searchParams.get("group") ?? "";
  const tracesView: TracesView = searchParams.get("view") === "spans" ? "spans" : "traces";

  const updateParams = useCallback(
    (mut: (p: URLSearchParams) => void, opts?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          mut(p);
          return p;
        },
        { replace: opts?.replace ?? true },
      );
    },
    [setSearchParams],
  );

  const setAttrs = useCallback(
    (next: ResourceAttr[]) => {
      updateParams((p) => {
        p.delete("attr");
        for (const a of next) p.append("attr", `${a.key}=${a.value}`);
      });
    },
    [updateParams],
  );
  const setSeverity = useCallback(
    (v: string) => updateParams((p) => (v ? p.set("sev", v) : p.delete("sev"))),
    [updateParams],
  );
  const setStatusCode = useCallback(
    (v: string) => updateParams((p) => (v ? p.set("status", v) : p.delete("status"))),
    [updateParams],
  );
  const setMetricName = useCallback(
    (v: string) => updateParams((p) => (v ? p.set("metric", v) : p.delete("metric"))),
    [updateParams],
  );
  const setGroupBy = useCallback(
    (v: string) => updateParams((p) => (v ? p.set("group", v) : p.delete("group"))),
    [updateParams],
  );
  const setTracesView = useCallback(
    (v: TracesView) =>
      updateParams((p) => (v === "spans" ? p.set("view", "spans") : p.delete("view"))),
    [updateParams],
  );
  const applyAbsoluteRange = useCallback(
    (nextRange: ExploreRange) => {
      updateParams((p) => {
        p.set("since", nextRange.since);
        p.set("until", nextRange.until);
        p.delete("range");
        p.delete("rangeLabel");
      });
    },
    [updateParams],
  );

  // Chart/UI prefs stay local — they're per-user view state, not part of the
  // shareable query.
  const [metricAggregation, setMetricAggregation] = useState<MetricAggregation>("avg");
  const [metricChartType, setMetricChartType] = useState<"line" | "bar">("line");
  const [metricShowXAxis, setMetricShowXAxis] = useState(true);
  const [metricShowYAxis, setMetricShowYAxis] = useState(true);
  const [metricShowLegend, setMetricShowLegend] = useState(true);
  const [limit, setLimit] = useState(100);

  // A page can be deep-linked (e.g. from an incident's telemetry query) to a
  // fixed absolute window via `?since=…&until=…`. When present and valid it
  // pins the range instead of the live "last N" preset; picking any preset in
  // the RangePicker clears these params and returns to a sliding window.
  const absoluteRange = useMemo(
    () => parseAbsoluteRange(searchParams.get("since"), searchParams.get("until")),
    [searchParams],
  );
  const range = useMemo(
    () => absoluteRange ?? rangeFromSeconds(selection.seconds, nowTick),
    [absoluteRange, selection, nowTick],
  );

  const savedViewState = useMemo<SavedExploreViewState | null>(() => {
    if (source !== "logs" && source !== "traces") return null;
    return captureSavedViewState({
      source,
      selection,
      absoluteRange,
      attrs,
      severity,
      statusCode,
      groupBy,
      tracesView,
    });
  }, [source, selection, absoluteRange, attrs, severity, statusCode, groupBy, tracesView]);

  const applySavedView = useCallback(
    (state: SavedExploreViewState, savedViewId?: string) => {
      if (state.range.type === "relative") {
        setSelection({ seconds: state.range.seconds, label: state.range.label });
        setNowTick(Date.now());
      }
      const nextParams = buildSavedViewSearchParams(state, savedViewId);
      const query = nextParams.toString();
      navigate(`${projectPath(`/explore/${state.source}`)}${query ? `?${query}` : ""}`);
    },
    [navigate, projectPath],
  );

  const filter: ExploreFilter = useMemo(
    () => ({
      range,
      resourceAttrs: attrs.length ? attrs : undefined,
      severity: source === "logs" && severity ? severity : undefined,
      statusCode: source === "traces" && statusCode ? statusCode : undefined,
    }),
    [range, attrs, source, severity, statusCode],
  );

  // Resolve the open log from the URL. The hook is disabled (via undefined
  // projectId) unless we're on the logs view *and* a log key is set, so we
  // don't fire avoidable /explore/logs requests on traces/metrics. When it
  // is enabled, React Query dedupes with the same fetch inside ListPanel.
  const selectedLogKey = searchParams.get("log");
  const logsForSelection = useExploreLogs(
    source === "logs" && selectedLogKey ? projectId : undefined,
    filter,
    limit,
  );
  const selectedLog = useMemo<LogRow | null>(() => {
    if (!selectedLogKey || !logsForSelection.data) return null;
    return logsForSelection.data.find((r) => logRowKey(r) === selectedLogKey) ?? null;
  }, [selectedLogKey, logsForSelection.data]);

  const openLog = useCallback(
    (log: LogRow) => {
      updateParams((p) => p.set("log", logRowKey(log)), { replace: false });
    },
    [updateParams],
  );
  const closeLog = useCallback(() => {
    updateParams((p) => p.delete("log"), { replace: false });
  }, [updateParams]);

  // Add a scope-prefixed attribute filter from a log/trace detail drawer to the
  // current view's filter bar. Mirrors what AddFilter does on pick, deduping
  // exact repeats so clicking the same attribute twice is a no-op. Severity has
  // a dedicated facet/pill, so the drawer's severity row (emitted as the
  // synthetic `field.severity` key) routes there instead of becoming a parallel
  // attr pill — keeping one canonical severity filter.
  const addFilter = useCallback(
    (key: string, value: string) => {
      if (key === "field.severity") {
        setSeverity(value);
        return;
      }
      setAttrs(addAttrFilter(attrs, key, value));
    },
    [attrs, setAttrs, setSeverity],
  );

  return (
    <div className="relative flex flex-col gap-6">
      <PageHeader
        title="Explore"
        description="Search, filter, and compare every signal in the current project."
      />
      <section className="flex flex-wrap items-center justify-between gap-4">
        <ExploreTabs />
        {/* Resources are inventory, not time-ranged telemetry — no range picker. */}
        {source !== "resources" && (
          <RangePicker
            value={absoluteRange ? { seconds: 0, label: CUSTOM_RANGE_LABEL } : selection}
            range={range}
            onAbsoluteChange={applyAbsoluteRange}
            onChange={(next) => {
              const span = tracer.startSpan("explore.range_change", {
                attributes: {
                  "explore.source": source,
                  "explore.range_label": next.label,
                  "explore.attr_count": attrs.length,
                },
              });
              try {
                setSelection(next);
                setNowTick(Date.now());
                // Picking a live preset drops any pinned-window params so the
                // range slides again — keyed on the raw params (not the parsed
                // range) so a malformed `since`/`until` gets cleaned up too.
                if (
                  searchParams.has("since") ||
                  searchParams.has("until") ||
                  searchParams.has("range") ||
                  searchParams.has("rangeLabel")
                ) {
                  updateParams((p) => {
                    p.delete("since");
                    p.delete("until");
                    p.delete("range");
                    p.delete("rangeLabel");
                  });
                }
              } finally {
                span.end();
              }
            }}
          />
        )}
      </section>

      {savedViewState && (
        <SavedViewBar
          projectId={projectId}
          source={savedViewState.source}
          currentState={savedViewState}
          activeViewId={searchParams.get("savedView")}
          onApply={applySavedView}
        />
      )}

      {source === "resources" ? (
        <ResourcesPanel projectId={projectId} />
      ) : source === "metrics" ? (
        <>
          <MetricNamePicker
            projectId={projectId}
            range={range}
            value={metricName}
            onChange={setMetricName}
          />
          <Tile padded={false}>
            <FilterBar
              projectId={projectId}
              range={range}
              attrs={attrs}
              onAttrsChange={setAttrs}
              className="px-5 py-3"
              extraRight={
                <div className="flex items-center gap-3">
                  <AggregationSelect value={metricAggregation} onChange={setMetricAggregation} />
                  <GroupBySelect
                    projectId={projectId}
                    range={range}
                    value={groupBy}
                    onChange={setGroupBy}
                  />
                  <ChartSettingsButton
                    chartType={metricChartType}
                    onChartTypeChange={setMetricChartType}
                    showXAxis={metricShowXAxis}
                    onShowXAxisChange={setMetricShowXAxis}
                    showYAxis={metricShowYAxis}
                    onShowYAxisChange={setMetricShowYAxis}
                    showLegend={metricShowLegend}
                    onShowLegendChange={setMetricShowLegend}
                  />
                </div>
              }
            />
            <div className="px-5 pb-5 pt-8">
              <MetricChartBody
                projectId={projectId}
                filter={filter}
                metricName={metricName}
                metricAggregation={metricAggregation}
                groupBy={groupBy}
                chartType={metricChartType}
                showXAxis={metricShowXAxis}
                showYAxis={metricShowYAxis}
                showLegend={metricShowLegend}
              />
            </div>
          </Tile>
        </>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">
          <ExploreFacets
            projectId={projectId}
            attrs={attrs}
            onAttrsChange={setAttrs}
            range={range}
            source={source}
            severity={severity}
            onSeverityChange={setSeverity}
            statusCode={statusCode}
            onStatusCodeChange={setStatusCode}
          />
          <div className="min-w-0 space-y-4">
            <ChartPanel
              projectId={projectId}
              filter={filter}
              source={source}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              range={range}
              onRangeChange={applyAbsoluteRange}
            />
            <ListPanel
              projectId={projectId}
              filter={filter}
              source={source}
              limit={limit}
              onLoadMore={() => setLimit((l) => Math.min(l + 100, 500))}
              attrs={attrs}
              onAttrsChange={setAttrs}
              range={range}
              metricName={metricName}
              tracesView={tracesView}
              onTracesViewChange={setTracesView}
              onSelectTrace={openTrace}
              onSelectLog={openLog}
              severity={severity}
              onSeverityChange={setSeverity}
              statusCode={statusCode}
              onStatusCodeChange={setStatusCode}
            />
          </div>
        </div>
      )}
      <TraceDrawer
        projectId={projectId}
        traceId={selectedTraceId}
        onClose={closeTrace}
        // The traces query filters on span.*/resource.* attributes, so only
        // offer inline filtering when the trace is being viewed on the traces
        // tab (a trace opened from the logs view filters logs, where span
        // attributes wouldn't apply).
        onAddFilter={source === "traces" ? addFilter : undefined}
      />
      <LogDrawer
        projectId={projectId}
        log={selectedLog}
        onClose={closeLog}
        onOpenTrace={(id) => {
          closeLog();
          openTrace(id);
        }}
        onOpenIssue={(id) => {
          closeLog();
          navigate(projectPath(`/issues/${id}`));
        }}
        onAddFilter={addFilter}
      />
      {selectedLogKey && !selectedLog && logsForSelection.isLoading && (
        <ExploreSignalDetailDrawerSkeleton source="logs" onClose={closeLog} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExploreTabs — logs · traces · metrics subpages
// ---------------------------------------------------------------------------
// ResourcesPanel — inventory of AWS resources discovered for the project.

function ResourcesPanel({ projectId }: { projectId: string }) {
  const projectPath = useProjectPath();
  const resources = useCloudResources(projectId);
  const connections = useCloudConnections(projectId);
  const sync = useSyncCloudConnection(projectId);

  const [search, setSearch] = useState("");
  const [service, setService] = useState("");
  const [region, setRegion] = useState("");

  const rows = useMemo(() => resources.data ?? [], [resources.data]);
  const connected = (connections.data ?? []).find((c) => c.status === "connected");

  const services = useMemo(() => Array.from(new Set(rows.map((r) => r.service))).sort(), [rows]);
  const regions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.region).filter((r): r is string => !!r))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (service && r.service !== service) return false;
      if (region && r.region !== region) return false;
      if (!q) return true;
      return (
        (r.name?.toLowerCase().includes(q) ?? false) ||
        r.arn.toLowerCase().includes(q) ||
        r.service.toLowerCase().includes(q)
      );
    });
  }, [rows, search, service, region]);

  // Empty state: no connection yet → point at Settings.
  if (!resources.isLoading && rows.length === 0 && !connected) {
    return (
      <Tile>
        <div className="space-y-3 py-6 text-center">
          <p className="text-[13px] text-muted">
            No AWS account connected yet. Connect one to inventory your resources.
          </p>
          <NavLink
            to={projectPath("/settings?scope=project&section=integrations")}
            className="inline-block rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-bg"
          >
            Connect AWS
          </NavLink>
        </div>
      </Tile>
    );
  }

  return (
    <Tile padded={false}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, ARN, or service…"
          className="max-w-xs"
        />
        <Dropdown
          value={service}
          onChange={setService}
          options={[
            { value: "", label: "All services" },
            ...services.map((s) => ({ value: s, label: s })),
          ]}
          searchable={services.length > 8}
        />
        <Dropdown
          value={region}
          onChange={setRegion}
          options={[
            { value: "", label: "All regions" },
            ...regions.map((r) => ({ value: r, label: r })),
          ]}
          searchable={regions.length > 8}
        />
        <div className="ml-auto flex items-center gap-3">
          <span className="font-sans text-[11px] text-subtle">
            {filtered.length} of {rows.length}
          </span>
          {connected && (
            <Btn
              size="sm"
              variant="secondary"
              loading={sync.isPending}
              onClick={() => sync.mutate(connected.id)}
            >
              Sync now
            </Btn>
          )}
        </div>
      </div>

      <div className="overflow-auto">
        {filtered.length === 0 ? (
          <div className="px-5 py-8 text-center font-sans text-[11px] text-subtle">
            {resources.isLoading ? "loading…" : "no resources"}
          </div>
        ) : (
          <table className="w-full border-collapse font-sans text-[12px]">
            <thead>
              <tr className="text-left text-subtle">
                <th className="px-5 py-2 font-normal">name</th>
                <th className="px-5 py-2 font-normal">service</th>
                <th className="px-5 py-2 font-normal">type</th>
                <th className="px-5 py-2 font-normal">region</th>
                <th className="px-5 py-2 font-normal">tags</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <ResourceRow key={r.id} r={r} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Tile>
  );
}

function ResourceRow({ r }: { r: CloudResourceRow }) {
  const tagCount = r.tags ? Object.keys(r.tags).length : 0;
  return (
    <tr className="border-t border-border align-top">
      <td className="px-5 py-2 text-fg" title={r.arn}>
        <span className="line-clamp-1 break-all">{r.name ?? r.arn}</span>
      </td>
      <td className="whitespace-nowrap px-5 py-2">
        <Chip tone="accent">{r.service}</Chip>
      </td>
      <td className="whitespace-nowrap px-5 py-2 text-muted">{r.resourceType ?? "—"}</td>
      <td className="whitespace-nowrap px-5 py-2 text-muted">{r.region ?? "—"}</td>
      <td className="px-5 py-2 text-subtle">{tagCount > 0 ? `${tagCount} tag(s)` : "—"}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

const TABS: { source: Source; label: string }[] = [
  { source: "logs", label: "Logs" },
  { source: "traces", label: "Traces" },
  { source: "metrics", label: "Metrics" },
  { source: "resources", label: "Resources" },
];

export function ExploreTabs() {
  const projectPath = useProjectPath();
  return (
    <nav className="flex items-center gap-1">
      {TABS.map((t) => (
        <NavLink
          key={t.source}
          to={projectPath(`/explore/${t.source}`)}
          className={({ isActive }) =>
            isActive
              ? "rounded-md bg-surface-3 px-3 py-1.5 text-[13px] font-medium tracking-tight text-fg"
              : "rounded-md px-3 py-1.5 text-[13px] font-medium tracking-tight text-muted hover:text-fg"
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

// Storybook variant — same shape, controlled by local state.
export function ExploreTabsStatic({
  source,
  onChange,
}: {
  source: Source;
  onChange: (s: Source) => void;
}) {
  return (
    <nav className="flex items-center gap-1">
      {TABS.map((t) => {
        const active = t.source === source;
        return (
          <button
            key={t.source}
            onClick={() => onChange(t.source)}
            className={
              active
                ? "rounded-md bg-surface-3 px-3 py-1.5 text-[13px] font-medium tracking-tight text-fg"
                : "rounded-md px-3 py-1.5 text-[13px] font-medium tracking-tight text-muted hover:text-fg"
            }
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

function FilterPill({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      title="remove"
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-soft px-2.5 font-sans text-[12px] tabular-nums text-accent transition-colors hover:brightness-110"
    >
      <span className="opacity-70">{facetDisplayName(label)}</span>
      <span>=</span>
      <span>{value}</span>
      <span className="ml-1 opacity-60">×</span>
    </button>
  );
}

function FilterBar({
  projectId,
  range,
  attrs,
  onAttrsChange,
  extraRight,
  className,
  leftIndent,
  source,
  severity,
  onSeverityChange,
  statusCode,
  onStatusCodeChange,
}: {
  projectId: string;
  range: ExploreRange;
  attrs: ResourceAttr[];
  onAttrsChange: (a: ResourceAttr[]) => void;
  extraRight?: ReactNode;
  className?: string;
  leftIndent?: string;
  source?: Source;
  severity?: string;
  onSeverityChange?: (v: string) => void;
  statusCode?: string;
  onStatusCodeChange?: (v: string) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  // `f` opens the add-filter popover from anywhere on the page (when no
  // input is focused). Same gesture pattern as the `/` shortcut on the
  // metric picker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          (t as HTMLElement).isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setAddOpen(true);
      addBtnRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handlePick = (f: AddedFilter) => {
    if (f.kind === "attr") {
      onAttrsChange([...attrs, { key: f.key, value: f.value }]);
    } else if (f.kind === "severity") {
      onSeverityChange?.(f.value);
    } else if (f.kind === "status") {
      onStatusCodeChange?.(f.value);
    }
    setAddOpen(false);
  };

  return (
    <div className={className ?? "px-5 py-3"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={`flex flex-wrap items-center gap-2 ${leftIndent ?? ""}`}>
          {source === "logs" && severity && onSeverityChange && (
            <FilterPill label="severity" value={severity} onRemove={() => onSeverityChange("")} />
          )}
          {source === "traces" && statusCode && onStatusCodeChange && (
            <FilterPill
              label="status"
              value={STATUS_LABEL_BY_VALUE[statusCode] ?? statusCode}
              onRemove={() => onStatusCodeChange("")}
            />
          )}
          {attrs.map((a, i) => (
            <FilterPill
              key={`${a.key}=${a.value}-${i}`}
              label={a.key}
              value={a.value}
              onRemove={() => onAttrsChange(attrs.filter((_, j) => j !== i))}
            />
          ))}
          <div className="relative">
            <button
              ref={addBtnRef}
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[12px] text-fg transition-colors hover:border-border-strong"
            >
              <span>+ Add filter</span>
              <ShortcutKey>F</ShortcutKey>
            </button>
            {addOpen && (
              <AddFilter
                projectId={projectId}
                range={range}
                source={source}
                existing={attrs}
                hasSeverity={!!severity}
                hasStatus={!!statusCode}
                onClose={() => setAddOpen(false)}
                onPick={handlePick}
              />
            )}
          </div>
        </div>
        {extraRight}
      </div>
    </div>
  );
}

const STATUS_LABEL_BY_VALUE: Record<string, string> = Object.fromEntries(
  STATUS_OPTIONS.map((o) => [o.value, o.label]),
);

type AddedFilter =
  | { kind: "attr"; key: string; value: string }
  | { kind: "severity"; value: string }
  | { kind: "status"; value: string };

// Shared primitives for the metric / filter search palettes — mirrors
// the org-switcher dropdown style (rounded-lg card, two-line rows with
// query-match highlighting, ↑↓/↵/Esc footer hints).

function PickerKbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm border border-border bg-surface px-1 py-px font-sans text-[10px] text-muted">
      {children}
    </span>
  );
}

function PickerFooter({
  navigateLabel = "Navigate",
  selectLabel = "Select",
  closeLabel = "Close",
}: {
  navigateLabel?: string;
  selectLabel?: string;
  closeLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border bg-surface-2 px-3 py-1.5 text-[10px] text-subtle">
      <div className="flex items-center gap-2">
        <PickerKbd>↑↓</PickerKbd>
        <span>{navigateLabel}</span>
        <PickerKbd>↵</PickerKbd>
        <span>{selectLabel}</span>
      </div>
      <div className="flex items-center gap-1">
        <PickerKbd>Esc</PickerKbd>
        <span>{closeLabel}</span>
      </div>
    </div>
  );
}

function highlightSubstring(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-fg">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

function PickerRow({
  active,
  highlighted,
  onClick,
  onMouseEnter,
  primary,
  secondary,
  query,
  trailing,
  disabled,
  dataIdx,
}: {
  active: boolean;
  highlighted: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  query: string;
  trailing?: React.ReactNode;
  disabled?: boolean;
  dataIdx?: number;
}) {
  // The action runs in onClick (not onMouseDown) so React's state update doesn't
  // flush mid-event and unmount the row before the parent's document-level
  // mousedown outside-click handler runs — that ordering used to make
  // `popover.contains(target)` return false on a detached node and close the
  // popover instead of advancing it. onMouseDown still prevents focus shift so
  // the search input keeps focus through the click.
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-idx={dataIdx}
        disabled={disabled}
        onMouseEnter={onMouseEnter}
        onMouseDown={(e) => {
          if (disabled) return;
          e.preventDefault();
        }}
        onClick={() => {
          if (disabled) return;
          onClick();
        }}
        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px] disabled:opacity-40 ${
          highlighted ? "bg-surface-2" : "hover:bg-surface-2"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-fg">
            {typeof primary === "string" ? highlightSubstring(primary, query) : primary}
          </div>
          {secondary && (
            <div className="truncate text-[11px] text-subtle">
              {typeof secondary === "string" ? highlightSubstring(secondary, query) : secondary}
            </div>
          )}
        </div>
        {trailing ? trailing : active && <PickerCheck />}
      </button>
    </li>
  );
}

function PickerCheck() {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-accent"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function PickerEmpty({ query, fallback }: { query: string; fallback?: string }) {
  if (!query) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-subtle">
        {fallback ?? "Nothing here yet."}
      </div>
    );
  }
  return (
    <div className="px-3 py-6 text-center text-[12px] text-subtle">
      No matches for "<span className="text-muted">{query}</span>"
    </div>
  );
}

function PickerSearchIcon() {
  return (
    <svg
      className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-subtle"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

// Subsequence-based fuzzy score: every char of `needle` must appear in
// `haystack` in order. Bonus for consecutive runs and word-boundary hits so
// `scu` ranks `system.cpu.usage` above `process.scheduler.uptime` etc.
// Returns null when no subsequence match exists.
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let score = 0;
  let hi = 0;
  let prevMatchedAt = -2;
  for (let ni = 0; ni < n.length; ni += 1) {
    const ch = n[ni];
    let foundAt = -1;
    while (hi < h.length) {
      if (h[hi] === ch) {
        foundAt = hi;
        hi += 1;
        break;
      }
      hi += 1;
    }
    if (foundAt < 0) return null;
    if (foundAt === prevMatchedAt + 1) score += 3;
    const prevCh = foundAt === 0 ? "." : h[foundAt - 1];
    if (prevCh === "." || prevCh === "_" || prevCh === "-" || prevCh === "/") score += 2;
    score += 1;
    prevMatchedAt = foundAt;
  }
  return score;
}

export function MetricNamePicker({
  projectId,
  range,
  value,
  onChange,
}: {
  projectId: string;
  range: ExploreRange;
  value: string;
  onChange: (name: string) => void;
}) {
  const names = useExploreMetricNames(projectId, range);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  // Hide the list once a metric is picked. Re-opens when the user focuses
  // the input or starts typing again.
  const [open, setOpen] = useState(!value);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Focus on mount. autoFocus alone misfires when the picker mounts on
  // route change (the previous tab still holds focus during the transition).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // `/` from anywhere on the metrics tab focuses the picker — same affordance
  // Linear / GitHub use. Ignored when the user is already typing into a form
  // field so it doesn't hijack legitimate `/` keystrokes elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          (t as HTMLElement).isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close the list when the user clicks outside the picker.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  const items = useMemo(() => {
    const list = names.data ?? [];
    const q = query.trim();
    if (!q) return [...list].sort((a, b) => a.name.localeCompare(b.name));
    const scored: { m: MetricName; score: number }[] = [];
    for (const m of list) {
      const s = fuzzyScore(q, m.name);
      if (s !== null) scored.push({ m, score: s });
    }
    scored.sort((a, b) => b.score - a.score || a.m.name.localeCompare(b.m.name));
    return scored.map((s) => s.m);
  }, [names.data, query]);

  useEffect(() => setHighlight(0), [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pick = (name: string) => {
    onChange(name);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = items[highlight];
      if (picked) pick(picked.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else setOpen(false);
    }
  };

  const q = query.trim().toLowerCase();

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`border border-border bg-surface shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)] focus-within:border-border-strong ${
          open ? "rounded-t-lg" : "rounded-lg"
        }`}
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <ShortcutKey>/</ShortcutKey>
          <input
            ref={inputRef}
            autoFocus
            placeholder={value ? value : "Search metrics…"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            aria-controls="metric-picker-listbox"
            aria-expanded={open}
            role="combobox"
            className={`h-7 flex-1 bg-transparent text-[13px] text-fg focus:outline-none ${
              value ? "placeholder:text-fg" : "placeholder:text-subtle"
            }`}
          />
        </div>
      </div>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 -mt-px overflow-hidden rounded-b-lg border border-border bg-surface shadow-[0_32px_64px_-12px_rgba(0,0,0,0.95),0_12px_24px_-8px_rgba(0,0,0,0.6)]">
          <div
            ref={listRef}
            id="metric-picker-listbox"
            role="listbox"
            className="max-h-72 overflow-auto"
          >
            {names.isLoading && (
              <div className="px-3 py-6 text-center text-[12px] text-subtle">loading…</div>
            )}
            {!names.isLoading && items.length === 0 && (
              <PickerEmpty query={query.trim()} fallback="No metrics in this window." />
            )}
            {items.length > 0 && (
              <ul>
                {items.map((m, i) => (
                  <PickerRow
                    key={`${m.kind}:${m.name}`}
                    dataIdx={i}
                    active={m.name === value}
                    highlighted={highlight === i}
                    onClick={() => pick(m.name)}
                    onMouseEnter={() => setHighlight(i)}
                    primary={m.name}
                    secondary={`${m.kind}${m.unit ? ` · ${m.unit}` : ""}`}
                    query={q}
                  />
                ))}
              </ul>
            )}
          </div>
          <PickerFooter />
        </div>
      )}
    </div>
  );
}

type FacetRow =
  | { kind: "severity"; label: string; haystack: string; disabled: boolean }
  | { kind: "status"; label: string; haystack: string; disabled: boolean }
  | { kind: "attr"; key: string; label: string; haystack: string; count: number };

type DrillTarget = { kind: "severity" } | { kind: "status" } | { kind: "attr"; key: string };

export function AddFilter({
  projectId,
  range,
  source,
  existing,
  hasSeverity,
  hasStatus,
  onPick,
  onClose,
}: {
  projectId: string;
  range: ExploreRange;
  source?: Source;
  existing: ResourceAttr[];
  hasSeverity?: boolean;
  hasStatus?: boolean;
  onPick: (f: AddedFilter) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [drill, setDrill] = useState<DrillTarget | undefined>();
  const [highlight, setHighlight] = useState(0);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset highlight whenever the visible list changes (typed query or drill).
  useEffect(() => {
    setHighlight(0);
  }, [search, drill]);

  // Explicitly focus the search input whenever we enter the root or the drill
  // view. autoFocus only runs on first mount; when the user drills in via
  // Enter, the root <input> unmounts and the drill <input> mounts, but the
  // focus that was on the root input has already been thrown away by the
  // unmount, and autoFocus on the new input doesn't reliably restore it.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, [drill?.kind, drill?.kind === "attr" ? drill.key : null]);

  const attrSource = source === "resources" ? undefined : source;
  const keys = useExploreAttributeKeys(projectId, range, attrSource);
  const values = useExploreAttributeValues(
    projectId,
    drill?.kind === "attr" ? drill.key : undefined,
    range,
    attrSource,
  );

  const existingPairs = useMemo(
    () => new Set(existing.map((a) => `${a.key}=${a.value}`)),
    [existing],
  );

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (!popoverRef.current) return;
      const target = e.target as Node;
      if (popoverRef.current.contains(target)) return;
      // The trigger button is a sibling — clicking it toggles state itself, so
      // ignore clicks on it to avoid the close-then-reopen race.
      const trigger = popoverRef.current.parentElement?.querySelector("button");
      if (trigger && trigger.contains(target)) return;
      onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const q = search.trim().toLowerCase();

  const popoverClass =
    "absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)]";

  if (drill) {
    const drillLabel =
      drill.kind === "attr" ? drill.key : drill.kind === "severity" ? "severity" : "status";
    const valueRows =
      drill.kind === "severity"
        ? SEVERITY_OPTIONS.map((s) => ({
            value: s,
            label: s,
            count: undefined as number | undefined,
          }))
        : drill.kind === "status"
          ? STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, count: undefined }))
          : (values.data ?? []).map((v) => ({ value: v.value, label: v.value, count: v.count }));
    const filtered = valueRows.filter(
      (r) => r.label.toLowerCase().includes(q) || r.value.toLowerCase().includes(q),
    );

    const pickDrillAt = (idx: number) => {
      const r = filtered[idx];
      if (!r) return;
      const already = drill.kind === "attr" && existingPairs.has(`${drill.key}=${r.value}`);
      if (already) return;
      if (drill.kind === "attr") {
        onPick({ kind: "attr", key: drill.key, value: r.value });
      } else if (drill.kind === "severity") {
        onPick({ kind: "severity", value: r.value });
      } else {
        onPick({ kind: "status", value: r.value });
      }
    };

    const onDrillKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        pickDrillAt(highlight);
      }
    };

    return (
      <div ref={popoverRef} className={popoverClass}>
        <div className="border-b border-border px-2.5 pb-2 pt-2.5">
          <button
            type="button"
            onClick={() => {
              setDrill(undefined);
              setSearch("");
            }}
            className="mb-1.5 flex items-center gap-1.5 text-[11px] text-subtle hover:text-fg"
          >
            <PickerBackArrow />
            <span className="truncate">{drillLabel}</span>
          </button>
          <div className="relative">
            <PickerSearchIcon />
            <input
              ref={searchInputRef}
              placeholder="Filter values…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onDrillKey}
              autoFocus
              className="h-7 w-full rounded-sm border border-border bg-surface-2 pl-7 pr-2 text-[12px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
            />
          </div>
        </div>
        <ScrollArea className="max-h-72">
          {drill.kind === "attr" && values.isLoading && (
            <div className="px-3 py-6 text-center text-[12px] text-subtle">loading…</div>
          )}
          {filtered.length === 0 ? (
            <PickerEmpty query={q} />
          ) : (
            <ul>
              {filtered.map((r, i) => {
                const already =
                  drill.kind === "attr" && existingPairs.has(`${drill.key}=${r.value}`);
                return (
                  <PickerRow
                    key={r.value}
                    dataIdx={i}
                    active={false}
                    highlighted={highlight === i}
                    disabled={already}
                    onClick={() => pickDrillAt(i)}
                    onMouseEnter={() => setHighlight(i)}
                    primary={r.label}
                    secondary={`${drillLabel} = ${r.value}`}
                    query={q}
                    trailing={
                      <span className="text-[10px] text-subtle">
                        {already ? "added" : r.count !== undefined ? r.count : ""}
                      </span>
                    }
                  />
                );
              })}
            </ul>
          )}
        </ScrollArea>
        <PickerFooter selectLabel="Add" closeLabel="Back" />
      </div>
    );
  }

  const facetRows: FacetRow[] = [];
  if (source === "logs") {
    facetRows.push({
      kind: "severity",
      label: "severity",
      haystack: "severity",
      disabled: !!hasSeverity,
    });
  }
  if (source === "traces") {
    facetRows.push({
      kind: "status",
      label: "status",
      haystack: "status",
      disabled: !!hasStatus,
    });
  }
  for (const k of keys.data ?? []) {
    facetRows.push({
      kind: "attr",
      key: k.key,
      label: k.key,
      haystack: k.key.toLowerCase(),
      count: k.count,
    });
  }
  const filtered = facetRows.filter((it) => it.haystack.includes(q));

  const pickFacetAt = (idx: number) => {
    const it = filtered[idx];
    if (!it) return;
    if (it.kind === "attr") {
      setDrill({ kind: "attr", key: it.key });
    } else {
      if (it.disabled) return;
      setDrill({ kind: it.kind });
    }
    setSearch("");
  };

  const onRootKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickFacetAt(highlight);
    }
  };

  return (
    <div ref={popoverRef} className={popoverClass}>
      <div className="border-b border-border px-2.5 pb-2 pt-2.5">
        <div className="relative">
          <PickerSearchIcon />
          <input
            ref={searchInputRef}
            placeholder="Find a filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onRootKey}
            autoFocus
            className="h-7 w-full rounded-sm border border-border bg-surface-2 pl-7 pr-2 text-[12px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
        </div>
      </div>
      <ScrollArea className="max-h-72">
        {keys.isLoading && (
          <div className="px-3 py-6 text-center text-[12px] text-subtle">loading…</div>
        )}
        {!keys.isLoading && filtered.length === 0 ? (
          <PickerEmpty query={q} />
        ) : (
          <ul>
            {filtered.map((it, i) => {
              if (it.kind === "attr") {
                return (
                  <PickerRow
                    key={`attr-${it.key}`}
                    dataIdx={i}
                    active={false}
                    highlighted={highlight === i}
                    onClick={() => pickFacetAt(i)}
                    onMouseEnter={() => setHighlight(i)}
                    primary={it.label}
                    secondary="attribute"
                    query={q}
                    trailing={<span className="text-[10px] text-subtle">{it.count} ›</span>}
                  />
                );
              }
              return (
                <PickerRow
                  key={`facet-${it.kind}`}
                  dataIdx={i}
                  active={false}
                  highlighted={highlight === i}
                  disabled={it.disabled}
                  onClick={() => pickFacetAt(i)}
                  onMouseEnter={() => setHighlight(i)}
                  primary={it.label}
                  secondary="facet"
                  query={q}
                  trailing={
                    <span className="text-[10px] text-subtle">{it.disabled ? "set" : "›"}</span>
                  }
                />
              );
            })}
          </ul>
        )}
      </ScrollArea>
      <PickerFooter selectLabel="Drill in" closeLabel="Close" />
    </div>
  );
}

function PickerBackArrow() {
  return (
    <svg
      aria-hidden
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ChartPanel
// ---------------------------------------------------------------------------

type KeyboardSelectOption = { value: string; label: string; meta?: string };

// Custom dropdown trigger + popover that matches the metric picker / filter
// picker style. Supports an optional global single-letter shortcut to open
// (excluded when an input is already focused, like the other shortcuts),
// keyboard nav (arrow/Enter/Esc), and an optional inline search box for
// long option lists.
function KeyboardSelect({
  value,
  options,
  onChange,
  shortcut,
  searchable = false,
  searchPlaceholder = "Search…",
  ariaLabel,
  placeholder,
  triggerLabel,
  width = "w-56",
}: {
  value: string;
  options: KeyboardSelectOption[];
  onChange: (v: string) => void;
  shortcut?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  ariaLabel: string;
  placeholder?: string;
  triggerLabel?: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== shortcut || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          (t as HTMLElement).isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setOpen(true);
      // Move focus into this control so the next ArrowDown / Enter the user
      // hits gets routed to its keydown handler — not to whichever element
      // was previously focused (e.g. another <select> on the page).
      // For searchable selects the `open` effect re-focuses the input via
      // setTimeout right after, which wins; non-searchable selects keep
      // focus on the trigger so the trigger's onKeyDown handles arrow nav.
      setTimeout(() => triggerRef.current?.focus(), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  useEffect(() => {
    if (!open) return;
    if (searchable) setTimeout(() => inputRef.current?.focus(), 0);
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKeyEsc);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKeyEsc);
    };
  }, [open, searchable]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[highlight];
      if (it) pick(it.value);
    }
  };

  const selected = options.find((o) => o.value === value);
  const selectedLabel = selected?.label ?? placeholder ?? "";

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          // Some browsers (Safari/Firefox on macOS) don't keep focus on a
          // button after a mouse click. Re-focus so the next ArrowDown /
          // Enter the user presses fires this button's onKeyDown handler
          // (non-searchable selects route arrow nav through here).
          triggerRef.current?.focus();
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
            e.preventDefault();
            setOpen(true);
          } else if (open && !searchable) {
            onListKey(e);
          }
        }}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-surface pl-2.5 pr-1.5 font-sans text-[12px] text-fg transition-colors hover:border-border-strong"
      >
        {triggerLabel && <span className="font-sans text-fg">{triggerLabel}:</span>}
        <span className="truncate text-fg">{selectedLabel}</span>
        {shortcut && <ShortcutKey>{shortcut.toUpperCase()}</ShortcutKey>}
      </button>
      {open && (
        <div
          className={`absolute right-0 top-full z-50 mt-2 ${width} overflow-hidden rounded-lg border border-border bg-surface shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)]`}
        >
          {searchable && (
            <div className="border-b border-border px-2.5 pb-2 pt-2.5">
              <div className="relative">
                <PickerSearchIcon />
                <input
                  ref={inputRef}
                  placeholder={searchPlaceholder}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onListKey}
                  className="h-7 w-full rounded-sm border border-border bg-surface-2 pl-7 pr-2 text-[12px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
                />
              </div>
            </div>
          )}
          <ScrollArea className="max-h-72">
            {items.length === 0 ? (
              <PickerEmpty query={query.trim()} />
            ) : (
              <ul>
                {items.map((it, i) => (
                  <PickerRow
                    key={it.value}
                    dataIdx={i}
                    active={it.value === value}
                    highlighted={highlight === i}
                    onClick={() => pick(it.value)}
                    onMouseEnter={() => setHighlight(i)}
                    primary={it.label}
                    secondary={it.meta}
                    query={query.trim().toLowerCase()}
                  />
                ))}
              </ul>
            )}
          </ScrollArea>
          <PickerFooter />
        </div>
      )}
    </div>
  );
}

export function GroupBySelect({
  projectId,
  range,
  source,
  value,
  onChange,
  step,
  shortcut = "g",
  triggerLabel = "Group by",
}: {
  projectId: string;
  range: ExploreRange;
  source?: Source;
  value: string;
  onChange: (g: string) => void;
  step?: string;
  // Pass `false` to suppress the global keyboard shortcut (e.g. when this is
  // nested inside a modal/popover rather than the Explore toolbar).
  shortcut?: string | false;
  // Pass `""` to render just the selected value without a "Group by:" prefix.
  triggerLabel?: string;
}) {
  const keys = useExploreAttributeKeys(
    projectId,
    range,
    source === "resources" ? undefined : source,
  );
  const options = useMemo<KeyboardSelectOption[]>(() => {
    const out: KeyboardSelectOption[] = [
      { value: "", label: "None" },
      { value: "service.name", label: "Service name" },
    ];
    for (const k of keys.data ?? []) {
      if (k.key === "service.name") continue;
      out.push({ value: k.key, label: facetDisplayName(k.key) });
    }
    return out;
  }, [keys.data]);

  return (
    <div className="flex items-center gap-2">
      <KeyboardSelect
        ariaLabel="group by"
        shortcut={shortcut || undefined}
        value={value}
        placeholder="None"
        triggerLabel={triggerLabel}
        options={options}
        searchable
        searchPlaceholder="Search attributes…"
        onChange={onChange}
      />
      {step && <span className="font-sans text-[10px] text-subtle">Step {step.toLowerCase()}</span>}
    </div>
  );
}

function AggregationSelect({
  value,
  onChange,
}: {
  value: MetricAggregation;
  onChange: (a: MetricAggregation) => void;
}) {
  const options = useMemo<KeyboardSelectOption[]>(
    () => METRIC_AGGREGATIONS.map((a) => ({ value: a, label: a })),
    [],
  );
  return (
    <KeyboardSelect
      ariaLabel="aggregation"
      shortcut="a"
      value={value}
      triggerLabel="Aggregation"
      options={options}
      onChange={(v) => onChange(v as MetricAggregation)}
    />
  );
}

function ChartPanel({
  projectId,
  filter,
  source,
  groupBy,
  onGroupByChange,
  range,
  onRangeChange,
  showControls = true,
}: {
  projectId: string;
  filter: ExploreFilter;
  source: Source;
  groupBy: string;
  onGroupByChange: (g: string) => void;
  range: ExploreRange;
  onRangeChange: (range: ExploreRange) => void;
  showControls?: boolean;
}) {
  const countSeries = useExploreSeries(
    projectId,
    source === "traces" ? "traces" : "logs",
    filter,
    groupBy || undefined,
  );
  const step = countSeries.data?.step;

  return (
    <Tile>
      {showControls && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <span className="font-sans text-[12px] font-medium text-subtle">Chart</span>
          <GroupBySelect
            projectId={projectId}
            range={range}
            source={source}
            value={groupBy}
            onChange={onGroupByChange}
            step={step}
          />
        </div>
      )}
      <div className="opacity-50">
        {countSeries.isLoading ? (
          <div className="flex h-14 items-center justify-center font-sans text-[11px] text-subtle">
            Loading…
          </div>
        ) : countSeries.data && countSeries.data.rows.length > 0 ? (
          <TimeseriesChart
            rows={countSeries.data.rows}
            height={72}
            range={range}
            step={countSeries.data.step}
            onRangeChange={onRangeChange}
          />
        ) : (
          <div className="flex h-14 items-center justify-center font-sans text-[11px] text-subtle">
            No data
          </div>
        )}
      </div>
    </Tile>
  );
}

function MetricChartBody({
  projectId,
  filter,
  metricName,
  metricAggregation,
  groupBy,
  chartType,
  showXAxis,
  showYAxis,
  showLegend,
}: {
  projectId: string;
  filter: ExploreFilter;
  metricName: string;
  metricAggregation: MetricAggregation;
  groupBy: string;
  chartType: "line" | "bar";
  showXAxis: boolean;
  showYAxis: boolean;
  showLegend: boolean;
}) {
  const q = useExploreMetricSeries(
    projectId,
    metricName || undefined,
    filter,
    groupBy || undefined,
    metricAggregation,
  );
  if (q.isLoading) {
    return <MetricDetailSkeleton />;
  }
  if (q.data && q.data.rows.length > 0) {
    return (
      <MetricLineChart
        rows={q.data.rows}
        chartType={chartType}
        showXAxis={showXAxis}
        showYAxis={showYAxis}
        showLegend={showLegend}
        height={260}
      />
    );
  }
  return (
    <div className="flex h-48 items-center justify-center font-sans text-[11px] text-subtle">
      {metricName ? "no data" : "pick a metric above"}
    </div>
  );
}

function ChartSettingsButton({
  chartType,
  onChartTypeChange,
  showXAxis,
  onShowXAxisChange,
  showYAxis,
  onShowYAxisChange,
  showLegend,
  onShowLegendChange,
}: {
  chartType: "line" | "bar";
  onChartTypeChange: (t: "line" | "bar") => void;
  showXAxis: boolean;
  onShowXAxisChange: (v: boolean) => void;
  showYAxis: boolean;
  onShowYAxisChange: (v: boolean) => void;
  showLegend: boolean;
  onShowLegendChange: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="chart settings"
        aria-expanded={open}
        className="inline-flex h-7 items-center justify-center rounded-md px-1.5 transition-colors hover:bg-surface-2"
      >
        <GearIcon />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-60 overflow-hidden rounded-lg border border-border bg-surface shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)]">
          <div className="px-3 pb-1.5 pt-2.5 text-[11px] font-medium text-subtle">Chart type</div>
          <div className="px-3 pb-3">
            <div className="flex gap-1.5">
              {(["line", "bar"] as const).map((t) => {
                const active = chartType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => onChartTypeChange(t)}
                    className={`h-7 flex-1 rounded-md text-[12.5px] transition-colors ${
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
          <div className="h-px bg-border" />
          <div className="px-3 pb-1.5 pt-2.5 text-[11px] font-medium text-subtle">Display</div>
          <ul className="pb-2">
            <SettingRow label="X-axis labels" checked={showXAxis} onChange={onShowXAxisChange} />
            <SettingRow label="Y-axis labels" checked={showYAxis} onChange={onShowYAxisChange} />
            <SettingRow label="Legend" checked={showLegend} onChange={onShowLegendChange} />
          </ul>
        </div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <li>
      <label className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-[12.5px] text-fg hover:bg-surface-2">
        <span>{label}</span>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-3.5 w-3.5 cursor-pointer accent-accent"
        />
      </label>
    </li>
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
      className="text-muted"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared chart helpers
// ---------------------------------------------------------------------------

const SERIES_COLORS = [
  "#485AE2",
  "#41D195",
  "#E7B15A",
  "#EF5A6F",
  "#B388FF",
  "#FFD166",
  "#06B6D4",
  "#E879F9",
];

const formatMetricValue = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
};

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "#161618",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 6,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: 11,
    padding: "6px 10px",
  },
  labelStyle: { color: "#8a8a8f", marginBottom: 4 },
  itemStyle: { color: "#f5f5f6", padding: 0 },
  cursor: { stroke: "rgba(255,255,255,0.12)", strokeWidth: 1 },
};

function pivotRows<T extends { bucket: string }>(
  rows: T[],
  keyFn: (r: T) => string,
  valFn: (r: T) => number,
): { data: Record<string, number | string>[]; groups: string[] } {
  const bucketSet = new Set<string>();
  const groupTotals = new Map<string, number>();
  for (const r of rows) {
    bucketSet.add(r.bucket);
    const k = keyFn(r) || "(none)";
    groupTotals.set(k, (groupTotals.get(k) ?? 0) + valFn(r));
  }
  const buckets = [...bucketSet].sort();
  const groups = [...groupTotals.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const byBucket = new Map(
    buckets.map((b) => [b, { bucket: b } as Record<string, number | string>]),
  );
  for (const r of rows) byBucket.get(r.bucket)![keyFn(r) || "(none)"] = valFn(r);
  return { data: buckets.map((b) => byBucket.get(b)!), groups };
}

// ---------------------------------------------------------------------------
// TimeseriesChart — stacked bars via Recharts
// ---------------------------------------------------------------------------

function formatBucket(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Pad sparse server data with zero-rows on every step boundary in the range so
// a single bucket renders as a thin tall bar at its real time position rather
// than stretching across the whole chart.
function padSeriesBuckets(
  rows: SeriesRow[],
  range: ExploreRange | undefined,
  step: string | undefined,
): SeriesRow[] {
  const ms = parseStepMs(step);
  if (!ms || !range) return rows;
  const seen = new Set(rows.map((r) => `${r.bucket}|${r.group}`));
  const groups = rows.length > 0 ? [...new Set(rows.map((r) => r.group))] : [""];
  const start = Math.floor(new Date(range.since).getTime() / ms) * ms;
  const end = new Date(range.until).getTime();
  const padded = [...rows];
  for (let t = start; t <= end; t += ms) {
    const bucket = formatBucket(new Date(t));
    for (const g of groups) {
      if (!seen.has(`${bucket}|${g}`)) {
        padded.push({ bucket, group: g, count: 0 });
      }
    }
  }
  return padded;
}

function pickEvenTicks<T>(items: T[], target: number, key: (t: T) => string): string[] {
  if (items.length === 0) return [];
  const n = Math.min(target, items.length);
  if (n <= 1) return [key(items[items.length - 1]!)];
  // Skip i=0: the leftmost tick crowds the chart's y-axis edge.
  const out: string[] = [];
  for (let i = 1; i < n; i++) {
    const idx = Math.round((i * (items.length - 1)) / (n - 1));
    out.push(key(items[idx]!));
  }
  return [...new Set(out)];
}

const AXIS_TICK_STYLE = {
  fill: "#6b7280",
  fontSize: 9,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
};
const LEGEND_STYLE = {
  fontSize: 10,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  paddingTop: 16,
};

export function TimeseriesChart({
  rows,
  height = 200,
  range,
  step,
  chartType = "bar",
  showXAxis = true,
  showYAxis = false,
  showLegend = false,
  onRangeChange,
}: {
  rows: SeriesRow[];
  height?: number | `${number}%`;
  range?: ExploreRange;
  step?: string;
  chartType?: "line" | "bar";
  showXAxis?: boolean;
  showYAxis?: boolean;
  showLegend?: boolean;
  onRangeChange?: (range: ExploreRange) => void;
}) {
  const [dragStart, setDragStart] = useState<string | null>(null);
  const [dragEnd, setDragEnd] = useState<string | null>(null);
  const filled = useMemo(() => padSeriesBuckets(rows, range, step), [rows, range, step]);
  const { data, groups } = useMemo(
    () =>
      pivotRows(
        filled,
        (r) => r.group,
        (r) => r.count,
      ),
    [filled],
  );
  const ticks = useMemo(() => pickEvenTicks(data, 5, (d) => d.bucket as string), [data]);
  const showDates = useMemo(
    () => bucketSeriesSpansDates(data.map((row) => String(row.bucket))),
    [data],
  );

  const Chart = chartType === "line" ? LineChart : BarChart;

  const activeBucket = (label: string | number | undefined) =>
    typeof label === "string" ? label : null;

  const finishDrag = (label: string | number | undefined) => {
    const last = activeBucket(label) ?? dragEnd ?? dragStart;
    if (dragStart && last && range && step && onRangeChange) {
      const nextRange = rangeFromBucketSelection(dragStart, last, step, range);
      if (nextRange) onRangeChange(nextRange);
    }
    setDragStart(null);
    setDragEnd(null);
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <Chart
        data={data}
        barCategoryGap={0}
        barGap={0}
        margin={{ top: 4, right: 0, bottom: showXAxis ? 6 : 0, left: 0 }}
        style={{ cursor: onRangeChange ? "crosshair" : undefined, userSelect: "none" }}
        onMouseDown={(state, event) => {
          if (!onRangeChange) return;
          const bucket = activeBucket(state.activeLabel);
          if (!bucket) return;
          event.preventDefault();
          setDragStart(bucket);
          setDragEnd(bucket);
        }}
        onMouseMove={(state) => {
          if (!dragStart) return;
          const bucket = activeBucket(state.activeLabel);
          if (bucket) setDragEnd(bucket);
        }}
        onMouseUp={(state) => finishDrag(state.activeLabel)}
        onMouseLeave={() => {
          setDragStart(null);
          setDragEnd(null);
        }}
      >
        <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="0" />
        {showXAxis ? (
          <XAxis
            dataKey="bucket"
            ticks={ticks}
            tickFormatter={(bucket) => formatBucketAxisTick(String(bucket), showDates)}
            axisLine={false}
            tickLine={false}
            height={showDates ? 28 : 18}
            tickMargin={4}
            tick={AXIS_TICK_STYLE}
          />
        ) : (
          <XAxis dataKey="bucket" hide />
        )}
        {showYAxis ? (
          <YAxis
            axisLine={false}
            tickLine={false}
            width={36}
            tickMargin={4}
            tick={AXIS_TICK_STYLE}
          />
        ) : (
          <YAxis hide width={0} />
        )}
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={(label) => formatLocalTimestamp(String(label))}
        />
        {dragStart && dragEnd && (
          <ReferenceArea
            x1={dragStart}
            x2={dragEnd}
            fill="var(--color-accent)"
            fillOpacity={0.16}
            stroke="var(--color-accent)"
            strokeOpacity={0.5}
          />
        )}
        {showLegend && <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" iconSize={10} />}
        {groups.map((g, gi) =>
          chartType === "line" ? (
            <Line
              key={g}
              type="monotone"
              dataKey={g}
              stroke={SERIES_COLORS[gi % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ) : (
            <Bar key={g} dataKey={g} stackId="a" fill={SERIES_COLORS[gi % SERIES_COLORS.length]} />
          ),
        )}
      </Chart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// MetricLineChart — line chart via Recharts
// ---------------------------------------------------------------------------

export function MetricLineChart({
  rows,
  chartType = "line",
  showXAxis = false,
  showYAxis = false,
  showLegend = false,
  height = 200,
}: {
  rows: MetricSeriesRow[];
  chartType?: "line" | "bar";
  showXAxis?: boolean;
  showYAxis?: boolean;
  showLegend?: boolean;
  height?: number | `${number}%`;
}) {
  const { data, groups } = useMemo(
    () =>
      pivotRows(
        rows,
        (r) => r.group,
        (r) => r.value,
      ),
    [rows],
  );
  const ticks = useMemo(() => pickEvenTicks(data, 5, (d) => d.bucket as string), [data]);

  const Chart = chartType === "bar" ? BarChart : LineChart;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <Chart
        data={data}
        barCategoryGap={0}
        barGap={0}
        margin={{ top: 4, right: 0, bottom: showXAxis ? 6 : 0, left: 0 }}
      >
        <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="0" />
        {showXAxis ? (
          <XAxis
            dataKey="bucket"
            ticks={ticks}
            tickFormatter={(bucket) => formatLocalHm(String(bucket))}
            axisLine={false}
            tickLine={false}
            height={18}
            tickMargin={4}
            tick={AXIS_TICK_STYLE}
          />
        ) : (
          <XAxis dataKey="bucket" hide />
        )}
        {showYAxis ? (
          <YAxis
            axisLine={false}
            tickLine={false}
            width={36}
            tickMargin={4}
            tick={AXIS_TICK_STYLE}
          />
        ) : (
          <YAxis hide width={0} />
        )}
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={formatMetricValue}
          labelFormatter={(label) => formatLocalTimestamp(String(label))}
        />
        {showLegend && <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" iconSize={10} />}
        {groups.map((g, gi) =>
          chartType === "bar" ? (
            <Bar key={g} dataKey={g} stackId="a" fill={SERIES_COLORS[gi % SERIES_COLORS.length]} />
          ) : (
            <Line
              key={g}
              type="monotone"
              dataKey={g}
              stroke={SERIES_COLORS[gi % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ),
        )}
      </Chart>
    </ResponsiveContainer>
  );
}

function ExploreSignalDetailDrawerSkeleton({
  source,
  onClose,
}: {
  source: TelemetrySource;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[720px] flex-col border-l border-border bg-bg shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          title="close (esc)"
          className="absolute right-4 top-4 z-10 rounded-sm border border-border bg-bg px-2 py-1 font-sans text-[11px] text-muted hover:text-fg"
        >
          ✕
        </button>
        <div className="flex-1 overflow-y-auto">
          <ExploreSignalDetailSkeleton source={source} />
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ListPanel
// ---------------------------------------------------------------------------

function ListPanel({
  projectId,
  filter,
  source,
  limit,
  onLoadMore,
  attrs,
  onAttrsChange,
  range,
  metricName,
  showFilters = true,
  tracesView = "spans",
  onTracesViewChange,
  onSelectTrace,
  onSelectLog,
  severity,
  onSeverityChange,
  statusCode,
  onStatusCodeChange,
}: {
  projectId: string;
  filter: ExploreFilter;
  source: TelemetrySource;
  limit: number;
  onLoadMore: () => void;
  attrs: ResourceAttr[];
  onAttrsChange: (a: ResourceAttr[]) => void;
  range: ExploreRange;
  metricName: string;
  showFilters?: boolean;
  tracesView?: TracesView;
  onTracesViewChange?: (v: TracesView) => void;
  onSelectTrace?: (traceId: string) => void;
  onSelectLog?: (log: LogRow) => void;
  severity?: string;
  onSeverityChange?: (v: string) => void;
  statusCode?: string;
  onStatusCodeChange?: (v: string) => void;
}) {
  const isTraceAgg = source === "traces" && tracesView === "traces";
  const logs = useExploreLogs(projectId, filter, source === "logs" ? limit : 0);
  const traces = useExploreTraces(
    projectId,
    filter,
    source === "traces" && tracesView === "spans" ? limit : 0,
  );
  const tracesAgg = useExploreTracesAggregated(projectId, filter, isTraceAgg ? limit : 0);
  const metrics = useExploreMetrics(
    projectId,
    filter,
    metricName || undefined,
    source === "metrics" ? limit : 0,
  );
  const q =
    source === "logs" ? logs : source === "traces" ? (isTraceAgg ? tracesAgg : traces) : metrics;
  const initialLoading = q.isLoading && !q.data;

  return (
    <Tile padded={false}>
      {showFilters && (
        <div className="border-b border-border">
          <FilterBar
            projectId={projectId}
            range={range}
            attrs={attrs}
            onAttrsChange={onAttrsChange}
            source={source}
            severity={severity}
            onSeverityChange={onSeverityChange}
            statusCode={statusCode}
            onStatusCodeChange={onStatusCodeChange}
            extraRight={
              source === "traces" && onTracesViewChange ? (
                <SegmentedToggle
                  value={tracesView}
                  options={[
                    { value: "traces", label: "Traces" },
                    { value: "spans", label: "Spans" },
                  ]}
                  onChange={(v) => onTracesViewChange(v as TracesView)}
                />
              ) : undefined
            }
          />
        </div>
      )}
      {q.isFetching && !initialLoading && (
        <div className="flex items-center justify-end border-b border-border px-5 py-1.5">
          <span className="font-sans text-[11px] text-subtle">Loading…</span>
        </div>
      )}
      <div className="overflow-auto">
        {initialLoading ? (
          <ExploreSignalListSkeleton source={source} />
        ) : source === "logs" ? (
          <LogsTable rows={(logs.data ?? []) as never} onSelect={onSelectLog} />
        ) : source === "traces" ? (
          isTraceAgg ? (
            <TracesAggregatedTable
              rows={(tracesAgg.data ?? []) as never}
              onSelectTrace={onSelectTrace}
            />
          ) : (
            <TracesTable rows={(traces.data ?? []) as never} onSelectTrace={onSelectTrace} />
          )
        ) : (
          <MetricsTable rows={(metrics.data ?? []) as never} />
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        <span className="font-sans text-[11px] text-subtle">
          Showing {q.data?.length ?? 0} (Limit {limit})
        </span>
        <Btn variant="secondary" size="sm" onClick={onLoadMore} disabled={limit >= 500}>
          Load more
        </Btn>
      </div>
    </Tile>
  );
}

export function LogsTable({
  rows,
  onSelect,
}: {
  rows: LogRow[];
  onSelect?: (log: LogRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-8 text-center font-sans text-[11px] text-subtle">No results</div>
    );
  }
  return (
    <table className="w-full border-collapse font-sans text-[12px]">
      <thead className="font-sans">
        <tr className="text-left text-subtle">
          <th className="px-5 py-2 font-normal">Timestamp</th>
          <th className="px-5 py-2 font-normal">Service</th>
          <th className="px-5 py-2 font-normal">Severity</th>
          <th className="px-5 py-2 font-normal">Body</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={i}
            className={`border-t border-border align-top ${
              onSelect ? "cursor-pointer hover:bg-surface-2" : ""
            }`}
            onClick={onSelect ? () => onSelect(r) : undefined}
          >
            <td className="whitespace-nowrap px-5 py-2 tabular-nums text-muted">
              {formatLocalTimestampMs(r.timestamp)}
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-fg">{r.service}</td>
            <td className="whitespace-nowrap px-5 py-2">
              <SeverityCell severity={r.severity} />
            </td>
            <td className="px-5 py-2 text-muted">
              <span className="line-clamp-2 break-all">{r.body}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SeverityCell({ severity }: { severity: string }) {
  const s = (severity || "").toUpperCase();
  // All severities share the same /15 background saturation so the column reads
  // as a single set of badges.
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
      className={`inline-flex items-center rounded-sm px-2 py-0.5 font-sans text-[11px] tabular-nums ${cls}`}
    >
      {s ? facetDisplayName(s) : "—"}
    </span>
  );
}

function fmtTimestampMs(s: string): string {
  // ClickHouse renders DateTime64(9) as "YYYY-MM-DD HH:MM:SS.fffffffff" (UTC).
  // Convert to local tz and round to 2 fractional digits.
  return formatLocalTimestampMs(s);
}

export function TracesTable({
  rows,
  onSelectTrace,
}: {
  rows: {
    timestamp: string;
    service: string;
    span_name: string;
    status_code: string;
    duration_ms: number;
    trace_id: string;
  }[];
  onSelectTrace?: (traceId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-8 text-center font-sans text-[11px] text-subtle">No results</div>
    );
  }
  return (
    <table className="w-full border-collapse font-sans text-[12px]">
      <thead className="font-sans">
        <tr className="text-left text-subtle">
          <th className="px-5 py-2 font-normal">Timestamp</th>
          <th className="px-5 py-2 font-normal">Service</th>
          <th className="px-5 py-2 font-normal">Span</th>
          <th className="px-5 py-2 font-normal">Status</th>
          <th className="px-5 py-2 text-right font-normal">Ms</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={i}
            onClick={onSelectTrace ? () => onSelectTrace(r.trace_id) : undefined}
            className={`border-t border-border align-top ${
              onSelectTrace ? "cursor-pointer hover:bg-surface-2" : ""
            }`}
          >
            <td className="whitespace-nowrap px-5 py-2 tabular-nums text-muted">
              {fmtTimestampMs(r.timestamp)}
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-fg">{r.service}</td>
            <td className="whitespace-nowrap px-5 py-2 text-muted">{r.span_name}</td>
            <td className="whitespace-nowrap px-5 py-2">
              <StatusCell code={r.status_code} />
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums text-muted">
              {r.duration_ms.toFixed(2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TracesAggregatedTable({
  rows,
  onSelectTrace,
}: {
  rows: TraceAggregatedRow[];
  onSelectTrace?: (traceId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-8 text-center font-sans text-[11px] text-subtle">No results</div>
    );
  }
  return (
    <table className="w-full border-collapse font-sans text-[12px]">
      <thead className="font-sans">
        <tr className="text-left text-subtle">
          <th className="px-5 py-2 font-normal">Started</th>
          <th className="px-5 py-2 font-normal">Service</th>
          <th className="px-5 py-2 font-normal">Root span</th>
          <th className="px-5 py-2 font-normal">Status</th>
          <th className="px-5 py-2 text-right font-normal">Spans</th>
          <th className="px-5 py-2 text-right font-normal">Errors</th>
          <th className="px-5 py-2 text-right font-normal">Ms</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.trace_id}
            onClick={onSelectTrace ? () => onSelectTrace(r.trace_id) : undefined}
            className={`border-t border-border align-top ${
              onSelectTrace ? "cursor-pointer hover:bg-surface-2" : ""
            }`}
          >
            <td className="whitespace-nowrap px-5 py-2 tabular-nums text-muted">
              {fmtTimestampMs(r.start_time)}
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-fg">{r.root_service}</td>
            <td className="px-5 py-2 text-muted">{r.root_span_name}</td>
            <td className="whitespace-nowrap px-5 py-2">
              <StatusCell code={r.root_status_code} />
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums text-muted">
              {Number(r.span_count)}
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums">
              {Number(r.error_count) > 0 ? (
                <span className="text-danger">{Number(r.error_count)}</span>
              ) : (
                <span className="text-subtle">0</span>
              )}
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums text-muted">
              {Number(r.duration_ms).toFixed(2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MetricsTable({ rows }: { rows: MetricRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-8 text-center font-sans text-[11px] text-subtle">no results</div>
    );
  }
  return (
    <table className="w-full border-collapse font-sans text-[12px]">
      <thead>
        <tr className="text-left text-subtle">
          <th className="px-5 py-2 font-normal">timestamp</th>
          <th className="px-5 py-2 font-normal">metric</th>
          <th className="px-5 py-2 font-normal">kind</th>
          <th className="px-5 py-2 font-normal">service</th>
          <th className="px-5 py-2 text-right font-normal">value</th>
          <th className="px-5 py-2 font-normal">unit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-border align-top">
            <td className="whitespace-nowrap px-5 py-2 tabular-nums text-muted">
              {formatLocalTimestampMs(r.timestamp)}
            </td>
            <td className="px-5 py-2 text-fg">{r.metric_name}</td>
            <td className="whitespace-nowrap px-5 py-2">
              <Chip tone="neutral">{r.kind}</Chip>
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-muted">{r.service || "—"}</td>
            <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums text-fg">
              {r.value != null
                ? r.value.toLocaleString(undefined, { maximumFractionDigits: 4 })
                : r.count != null
                  ? r.count.toLocaleString()
                  : "—"}
            </td>
            <td className="whitespace-nowrap px-5 py-2 text-subtle">{r.unit || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusCell({ code }: { code: string }) {
  const tone =
    code === "STATUS_CODE_ERROR" ? "danger" : code === "STATUS_CODE_OK" ? "success" : "muted";
  const label = code?.replace("STATUS_CODE_", "").toLowerCase() || "—";
  return <Chip tone={tone}>{label}</Chip>;
}

// ---------------------------------------------------------------------------
// SegmentedToggle
// ---------------------------------------------------------------------------

export function SegmentedToggle({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-sm border border-border bg-surface-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`h-7 px-3 font-sans text-[11px] tracking-tight transition-colors ${
              active ? "bg-accent text-accent-ink" : "text-muted hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
