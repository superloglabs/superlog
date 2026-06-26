import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AddFilter, MetricNamePicker } from "../Explore.tsx";
import { type ExploreRange, type ResourceAttr, useExploreAttributeKeys, useMe } from "../api.ts";
import { Dropdown } from "../design/Dropdown.tsx";
import { Btn, Chip, Input, PillToggle, Tile } from "../design/ui.tsx";
import { CountChart } from "../dashboards/widgets/CountChart.tsx";
import { SettingsCard, SettingsCardFooter, SettingsRow } from "../settings/rows.tsx";
import {
  useAlert,
  useAlertEpisodes,
  useCreateAlert,
  usePreviewAlert,
  usePreviewAlertSeries,
  useUpdateAlert,
} from "./api.ts";
import type {
  AlertAggregation,
  AlertComparator,
  AlertCreateBody,
  AlertEpisode,
  AlertGroupMode,
  AlertPreviewSeries,
  AlertSeriesRow,
  AlertSource,
  AlertTestResult,
} from "./types.ts";

function defaultRange(): ExploreRange {
  const until = new Date();
  const since = new Date(until.getTime() - 60 * 60_000);
  return { since: since.toISOString(), until: until.toISOString() };
}

export function AlertEdit() {
  const me = useMe();
  const params = useParams();
  const id = params.id;
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
  return <AlertEditInner projectId={me.data.project.id} alertId={id} />;
}

function AlertEditInner({ projectId, alertId }: { projectId: string; alertId?: string }) {
  const navigate = useNavigate();
  const editing = !!alertId;
  const existing = useAlert(projectId, alertId);

  const [name, setName] = useState("untitled alert");
  const [enabled, setEnabled] = useState(true);
  const [source, setSource] = useState<AlertSource>("logs");
  const [metricName, setMetricName] = useState("");
  const [attrs, setAttrs] = useState<ResourceAttr[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [groupBy, setGroupBy] = useState("");
  const [groupMode, setGroupMode] = useState<AlertGroupMode>("single");
  const [aggregation, setAggregation] = useState<AlertAggregation>("count");
  const [comparator, setComparator] = useState<AlertComparator>("gt");
  const [threshold, setThreshold] = useState<number>(0);
  const [windowMinutes, setWindowMinutes] = useState<number>(5);
  const [evaluationIntervalSeconds, setEvaluationIntervalSeconds] = useState<number>(60);

  useEffect(() => {
    if (!editing || !existing.data) return;
    const a = existing.data;
    setName(a.name);
    setEnabled(a.enabled);
    setSource(a.source);
    setMetricName(a.metricName ?? "");
    setAttrs(a.filter.resourceAttrs ?? []);
    setGroupBy(a.groupBy ?? "");
    setGroupMode(a.groupMode);
    setAggregation(a.aggregation);
    setComparator(a.comparator);
    setThreshold(a.threshold);
    setWindowMinutes(a.windowMinutes);
    setEvaluationIntervalSeconds(a.evaluationIntervalSeconds);
  }, [editing, existing.data]);

  // Coerce aggregation when source changes
  useEffect(() => {
    if (source === "metric" && aggregation === "count") setAggregation("sum");
    if (source !== "metric" && aggregation !== "count") setAggregation("count");
  }, [source, aggregation]);

  // Reset groupMode if groupBy is cleared
  useEffect(() => {
    if (!groupBy && groupMode === "per_group") setGroupMode("single");
  }, [groupBy, groupMode]);

  const range = useMemo(defaultRange, []);
  const keys = useExploreAttributeKeys(projectId, range);

  const create = useCreateAlert(projectId);
  const update = useUpdateAlert(projectId, alertId ?? "");
  const preview = usePreviewAlert(projectId);
  const previewSeries = usePreviewAlertSeries(projectId);

  const body: AlertCreateBody = useMemo(
    () => ({
      name,
      enabled,
      source,
      metricName: source === "metric" ? metricName : null,
      filter: { resourceAttrs: attrs.length ? attrs : undefined },
      groupBy: groupBy || null,
      groupMode,
      aggregation,
      comparator,
      threshold,
      windowMinutes,
      evaluationIntervalSeconds,
    }),
    [
      name,
      enabled,
      source,
      metricName,
      attrs,
      groupBy,
      groupMode,
      aggregation,
      comparator,
      threshold,
      windowMinutes,
      evaluationIntervalSeconds,
    ],
  );

  const valid =
    !!name.trim() &&
    !(source === "metric" && !metricName) &&
    !(groupMode === "per_group" && !groupBy) &&
    Number.isFinite(threshold);

  const submit = async () => {
    if (!valid) return;
    if (editing && alertId) {
      await update.mutateAsync(body);
    } else {
      const created = await create.mutateAsync(body);
      navigate(`/alerts/${created.id}`, { replace: true });
      return;
    }
    navigate("/alerts");
  };

  // Keep the preview in sync with the rule as you edit it. Debounced so typing
  // a threshold doesn't fire a request per keystroke. Only the fields that
  // affect the evaluated signal are in the key (name/enabled/interval don't).
  const previewKey = useMemo(
    () =>
      JSON.stringify({
        source,
        metricName: source === "metric" ? metricName : null,
        attrs,
        groupBy,
        groupMode,
        aggregation,
        comparator,
        threshold,
        windowMinutes,
      }),
    [source, metricName, attrs, groupBy, groupMode, aggregation, comparator, threshold, windowMinutes],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run is keyed by previewKey; body/mutations are read fresh.
  useEffect(() => {
    if (!valid) return;
    const id = setTimeout(() => {
      preview.mutate(body);
      previewSeries.mutate(body);
    }, 400);
    return () => clearTimeout(id);
  }, [previewKey, valid]);

  const aggregationOptions =
    source === "metric"
      ? [
          { value: "sum", label: "Sum" },
          { value: "avg", label: "Avg" },
        ]
      : [{ value: "count", label: "Count" }];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled alert"
            aria-label="Alert name"
            className="w-full bg-transparent text-[22px] font-semibold text-fg placeholder:text-subtle focus:outline-none"
          />
          <p className="mt-0.5 text-[12.5px] text-muted">
            Get notified when your telemetry crosses a threshold.
          </p>
        </div>
        <div className="shrink-0 pt-1.5">
          <PillToggle
            value={enabled ? "on" : "off"}
            options={[
              { value: "on", label: "Enabled" },
              { value: "off", label: "Disabled" },
            ]}
            onChange={(v) => setEnabled(v === "on")}
          />
        </div>
      </header>

      <div className="flex items-center justify-between gap-3">
        <PillToggle
          value={source}
          options={[
            { value: "logs", label: "Logs" },
            { value: "traces", label: "Traces" },
            { value: "metric", label: "Metric" },
          ]}
          onChange={(v) => setSource(v as AlertSource)}
        />
      </div>

      <SettingsCard>
        <SettingsRow
          title="Preview"
          description="The evaluated signal against the threshold over recent history"
          control={
            (preview.isPending || previewSeries.isPending) && (
              <span className="text-[12px] text-subtle">updating…</span>
            )
          }
        >
          {preview.error || previewSeries.error ? (
            <div className="text-[12px] text-danger">
              {String(preview.error ?? previewSeries.error)}
            </div>
          ) : previewSeries.data || preview.data ? (
            <div className="flex flex-col gap-4">
              {preview.data && (
                <PreviewResult result={preview.data} threshold={threshold} comparator={comparator} />
              )}
              {previewSeries.data && <AlertPreviewChart series={previewSeries.data} />}
            </div>
          ) : valid ? (
            <div className="text-[12px] text-subtle">Loading preview…</div>
          ) : (
            <div className="text-[12px] text-subtle">
              Fill in the required fields to preview this rule.
            </div>
          )}
        </SettingsRow>
      </SettingsCard>

      <SettingsCard>
        {source === "metric" && (
          <SettingsRow title="Metric" description="The metric to aggregate">
            <MetricNamePicker
              projectId={projectId}
              range={range}
              value={metricName}
              onChange={setMetricName}
            />
          </SettingsRow>
        )}

        <SettingsRow title="Filters" description="Narrow down the data this rule looks at">
          <div className="flex flex-wrap items-center gap-2">
            {attrs.map((a, i) => (
              <button
                key={`${a.key}=${a.value}-${i}`}
                onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}
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
                    if (f.kind === "attr") setAttrs([...attrs, { key: f.key, value: f.value }]);
                    setFilterOpen(false);
                  }}
                />
              )}
            </div>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Group by"
          description="Evaluate separately for each value of an attribute"
          control={
            <Dropdown
              className="w-60"
              value={groupBy}
              onChange={setGroupBy}
              placeholder="None"
              options={[
                { value: "", label: "None" },
                { value: "service.name", label: "service.name" },
                ...(keys.data ?? [])
                  .filter((k) => k.key !== "service.name")
                  .map((k) => ({ value: k.key, label: k.key })),
              ]}
            />
          }
        />

        {groupBy && (
          <SettingsRow
            title="Group mode"
            description="One alert in total, or one per group"
            control={
              <PillToggle
                value={groupMode}
                options={[
                  { value: "single", label: "One total" },
                  { value: "per_group", label: "Per group" },
                ]}
                onChange={(v) => setGroupMode(v as AlertGroupMode)}
              />
            }
          />
        )}

        {source === "metric" && (
          <SettingsRow
            title="Aggregation"
            description="How to combine the metric's data points in the window"
            control={
              <PillToggle
                value={aggregation}
                options={aggregationOptions}
                onChange={(v) => setAggregation(v as AlertAggregation)}
              />
            }
          />
        )}

        <SettingsRow
          title="Condition"
          description="Fire when the aggregated value crosses the threshold"
          control={
            <div className="flex items-center gap-2">
              <PillToggle
                value={comparator}
                options={[
                  { value: "gt", label: "Above" },
                  { value: "lt", label: "Below" },
                ]}
                onChange={(v) => setComparator(v as AlertComparator)}
              />
              <div className="w-28">
                <Input
                  type="number"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                />
              </div>
            </div>
          }
        />

        <SettingsRow
          title="Window"
          description="Look back over this many minutes on each check"
          control={
            <div className="w-28">
              <Input
                type="number"
                min={1}
                max={1440}
                value={windowMinutes}
                onChange={(e) => setWindowMinutes(Math.max(1, Number(e.target.value) || 5))}
              />
            </div>
          }
        />

        <SettingsRow
          title="Check every"
          description="How often to evaluate the rule, in seconds"
          control={
            <div className="w-28">
              <Input
                type="number"
                min={15}
                max={3600}
                value={evaluationIntervalSeconds}
                onChange={(e) =>
                  setEvaluationIntervalSeconds(Math.max(15, Number(e.target.value) || 60))
                }
              />
            </div>
          }
        />

        <SettingsCardFooter>
          {!valid && (
            <span className="mr-auto text-[12px] text-muted">
              Fill in the required fields to continue
            </span>
          )}
          <Btn variant="ghost" size="sm" onClick={() => navigate("/alerts")}>
            Cancel
          </Btn>
          <Btn
            size="sm"
            onClick={submit}
            disabled={!valid}
            loading={create.isPending || update.isPending}
          >
            {editing ? "Save" : "Create"}
          </Btn>
        </SettingsCardFooter>
      </SettingsCard>

      {editing && alertId && <EpisodesTile projectId={projectId} alertId={alertId} />}
    </div>
  );
}

// Stable accessor so CountChart's series memo doesn't recompute each render.
const seriesValue = (r: AlertSeriesRow) => r.value;

// The evaluated signal over recent history, drawn with the same chart the
// dashboard widgets use, plus a dashed line at the threshold.
function AlertPreviewChart({ series }: { series: AlertPreviewSeries }) {
  if (series.rows.length === 0) {
    return (
      <div className="text-[12px] text-subtle">
        No data in the last {series.windowMinutes * 24} minutes for this signal.
      </div>
    );
  }
  return (
    <div className="h-44 w-full">
      <CountChart
        rows={series.rows}
        value={seriesValue}
        range={series.range}
        step={series.step}
        chartType="line"
        limit={1}
        showXAxis
        showYAxis
        showLegend={false}
        legendPosition="side"
        threshold={series.threshold}
        thresholdLabel={`threshold ${formatNum(series.threshold)}`}
      />
    </div>
  );
}

// A colored status dot + a plain capitalized word — no chip background.
function StatusDot({ tone, label }: { tone: "danger" | "muted" | "success"; label: string }) {
  const dot = tone === "danger" ? "bg-danger" : tone === "success" ? "bg-success" : "bg-subtle";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-fg">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = Math.max(0, end - new Date(startedAt).getTime());
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `${hrs}h${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d${hrs % 24 ? `${hrs % 24}h` : ""}`;
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2);
}

// An alert's contiguous activations. Each row links to the incident it raised
// so you can jump from "the alert fired" to "what we did about it". Styled to
// match the settings cards (Tile header + divide-y rows, no mono/caps).
function EpisodesTile({ projectId, alertId }: { projectId: string; alertId: string }) {
  const episodes = useAlertEpisodes(projectId, alertId);
  const rows = episodes.data ?? [];
  return (
    <Tile padded={false}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="text-[12px] text-muted">Episodes</span>
        {rows.length > 0 && <span className="text-[12px] text-subtle">{rows.length}</span>}
      </div>
      {episodes.isLoading ? (
        <div className="px-5 py-6 text-[12px] text-muted">Loading…</div>
      ) : episodes.error ? (
        <div className="px-5 py-6 text-[12px] text-danger">{String(episodes.error)}</div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-6 text-[12px] text-muted">
          No episodes yet — this alert hasn't fired since episodes were tracked.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((ep) => (
            <EpisodeRow key={ep.id} ep={ep} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

function EpisodeRow({ ep }: { ep: AlertEpisode }) {
  const firing = ep.state === "firing";
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] text-fg">Episode #{ep.seq}</span>
          <StatusDot tone={firing ? "danger" : "muted"} label={firing ? "Firing" : "Resolved"} />
          {ep.groupKey && <Chip tone="accent">{ep.groupKey}</Chip>}
        </div>
        <div className="mt-0.5 text-[11px] text-subtle">
          {new Date(ep.startedAt).toLocaleString()} ·{" "}
          {firing ? "ongoing" : formatDuration(ep.startedAt, ep.endedAt)} · peak{" "}
          {formatNum(ep.peakObservedValue)}
        </div>
      </div>
      {ep.incident ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
          <span className="font-mono">{ep.incident.codename || "incident"}</span>
          {ep.incident.severity ? (
            <span className="text-[11px] text-subtle">{ep.incident.severity}</span>
          ) : null}
          <svg
            className="h-3 w-3 text-subtle"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </span>
      ) : (
        <span className="shrink-0 text-[11px] text-subtle">No incident</span>
      )}
    </>
  );
  // The whole row links to the incident the episode is part of.
  if (ep.incident) {
    return (
      <li>
        <Link
          to={`/incidents/${ep.incident.id}`}
          className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
        >
          {body}
        </Link>
      </li>
    );
  }
  return <li className="flex items-center justify-between gap-3 px-5 py-3">{body}</li>;
}

function PreviewResult({
  result,
  threshold,
  comparator,
}: {
  result: AlertTestResult;
  threshold: number;
  comparator: AlertComparator;
}) {
  const op = comparator === "gt" ? "above" : "below";
  if (result.mode === "single") {
    return (
      <div className="flex items-center gap-3">
        <StatusDot
          tone={result.breaches > 0 ? "danger" : "success"}
          label={result.breaches > 0 ? "Firing" : "OK"}
        />
        <span className="text-[12px] text-muted">
          value{" "}
          <span className="tabular-nums text-fg">{result.value.toFixed(2)}</span> {op} {threshold}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12px] text-muted">
        {result.breaches} of {result.groups.length} groups breaching
      </div>
      <div className="divide-y divide-border rounded-md border border-border">
        {result.groups.length === 0 && (
          <div className="px-3 py-2 text-[12px] text-subtle">No groups in window</div>
        )}
        {result.groups.map((g) => (
          <div key={g.key} className="flex items-center gap-3 px-3 py-2">
            <StatusDot tone={g.breaching ? "danger" : "success"} label={g.breaching ? "Firing" : "OK"} />
            <span className="flex-1 truncate text-[12.5px] text-fg">{g.key || "(empty)"}</span>
            <span className="tabular-nums text-[12.5px] text-muted">{g.value.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
