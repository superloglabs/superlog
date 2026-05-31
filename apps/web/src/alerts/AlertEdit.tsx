import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AddFilter, MetricNamePicker, SegmentedToggle } from "../Explore.tsx";
import { type ExploreRange, type ResourceAttr, useExploreAttributeKeys, useMe } from "../api.ts";
import { Btn, Chip, FieldLabel, Input, Label, Tile } from "../design/ui.tsx";
import { useAlert, useCreateAlert, usePreviewAlert, useUpdateAlert } from "./api.ts";
import type {
  AlertAggregation,
  AlertComparator,
  AlertCreateBody,
  AlertGroupMode,
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

  const runPreview = () => {
    if (!valid) return;
    preview.mutate(body);
  };

  const aggregationOptions =
    source === "metric"
      ? [
          { value: "sum", label: "sum" },
          { value: "avg", label: "avg" },
        ]
      : [{ value: "count", label: "count" }];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex items-center justify-between">
        <div className="flex flex-col">
          <Label>{editing ? "edit alert" : "new alert"}</Label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 bg-transparent text-[20px] font-medium text-fg focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-3">
          <Btn variant="ghost" onClick={() => navigate("/alerts")}>
            cancel
          </Btn>
          <Btn onClick={submit} disabled={!valid} loading={create.isPending || update.isPending}>
            {editing ? "save" : "create"}
          </Btn>
        </div>
      </section>

      <Tile>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <FieldLabel>enabled</FieldLabel>
            <button
              onClick={() => setEnabled((v) => !v)}
              className="font-mono text-[11px] uppercase tracking-[0.15em]"
            >
              <Chip tone={enabled ? "accent" : "neutral"}>{enabled ? "yes" : "no"}</Chip>
            </button>
          </div>

          <div>
            <FieldLabel>source</FieldLabel>
            <SegmentedToggle
              value={source}
              options={[
                { value: "logs", label: "logs" },
                { value: "traces", label: "traces" },
                { value: "metric", label: "metric" },
              ]}
              onChange={(v) => setSource(v as AlertSource)}
            />
          </div>

          {source === "metric" && (
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

          <div>
            <FieldLabel>filters</FieldLabel>
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
          </div>

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

          {groupBy && (
            <div>
              <FieldLabel>group mode</FieldLabel>
              <SegmentedToggle
                value={groupMode}
                options={[
                  { value: "single", label: "one alert total" },
                  { value: "per_group", label: "one alert per group" },
                ]}
                onChange={(v) => setGroupMode(v as AlertGroupMode)}
              />
            </div>
          )}

          <div>
            <FieldLabel>aggregation</FieldLabel>
            <SegmentedToggle
              value={aggregation}
              options={aggregationOptions}
              onChange={(v) => setAggregation(v as AlertAggregation)}
            />
          </div>

          <div className="flex items-end gap-3">
            <div className="w-32">
              <FieldLabel>comparator</FieldLabel>
              <SegmentedToggle
                value={comparator}
                options={[
                  { value: "gt", label: "&gt;" },
                  { value: "lt", label: "&lt;" },
                ]}
                onChange={(v) => setComparator(v as AlertComparator)}
              />
            </div>
            <div className="flex-1">
              <FieldLabel>threshold</FieldLabel>
              <Input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <FieldLabel>window (minutes)</FieldLabel>
              <Input
                type="number"
                min={1}
                max={1440}
                value={windowMinutes}
                onChange={(e) => setWindowMinutes(Math.max(1, Number(e.target.value) || 5))}
              />
            </div>
            <div className="flex-1">
              <FieldLabel>check every (seconds)</FieldLabel>
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
          </div>
        </div>
      </Tile>

      <Tile>
        <div className="flex items-center justify-between">
          <Label>preview</Label>
          <Btn
            variant="secondary"
            size="sm"
            onClick={runPreview}
            loading={preview.isPending}
            disabled={!valid}
          >
            run preview
          </Btn>
        </div>
        {preview.error && (
          <div className="mt-3 font-mono text-[11px] text-danger">
            error: {String(preview.error)}
          </div>
        )}
        {preview.data && (
          <PreviewResult result={preview.data} threshold={threshold} comparator={comparator} />
        )}
        {!preview.data && !preview.error && (
          <div className="mt-3 font-mono text-[11px] text-subtle">
            run preview to see what this rule would produce against the last {windowMinutes}{" "}
            minute(s)
          </div>
        )}
      </Tile>
    </div>
  );
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
  const op = comparator === "gt" ? ">" : "<";
  if (result.mode === "single") {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Chip tone={result.breaches > 0 ? "danger" : "neutral"}>
            {result.breaches > 0 ? "FIRING" : "OK"}
          </Chip>
          <span className="font-mono text-[12px] text-fg">
            value = {result.value.toFixed(2)} {op} {threshold}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="font-mono text-[11px] text-muted">
        {result.breaches} of {result.groups.length} groups breaching
      </div>
      <div className="border border-border">
        {result.groups.length === 0 && (
          <div className="px-3 py-2 font-mono text-[11px] text-subtle">no groups in window</div>
        )}
        {result.groups.map((g) => (
          <div
            key={g.key}
            className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
          >
            <Chip tone={g.breaching ? "danger" : "neutral"}>{g.breaching ? "FIRING" : "OK"}</Chip>
            <span className="flex-1 font-mono text-[12px] text-fg">{g.key || "(empty)"}</span>
            <span className="font-mono text-[12px] tabular-nums text-muted">
              {g.value.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
