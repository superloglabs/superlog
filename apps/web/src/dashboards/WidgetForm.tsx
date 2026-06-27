import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AddFilter, GroupBySelect, MetricNamePicker } from "../Explore.tsx";
import { type ExploreRange, METRIC_AGGREGATIONS } from "../api.ts";
import { Btn, Chip, Input, Label, PillToggle, Tile } from "../design/ui.tsx";
import { SettingsCard, SettingsRow } from "../settings/rows.tsx";
import {
  type Widget,
  type WidgetConfig,
  type WidgetType,
  defaultChartType,
  defaultLayoutFor,
} from "./types.ts";
import {
  type WidgetFormState,
  buildWidgetConfig,
  generateTitle,
  widgetTypeFor,
} from "./widget-config.ts";
import { WidgetBody } from "./widgets/WidgetBody.tsx";
import { WIDGET_UNITS, WIDGET_UNIT_LABELS } from "./widgets/widget-format.ts";

export function WidgetForm({
  projectId,
  range,
  mode,
  initial,
  existingTitle,
  submitting,
  onSubmit,
  onClose,
}: {
  projectId: string;
  range: ExploreRange;
  mode: "create" | "edit";
  initial: WidgetFormState;
  // When editing, the widget's current title is preserved (it stays
  // independently renamable from the widget header) instead of being
  // regenerated from the form.
  existingTitle?: string;
  submitting: boolean;
  onSubmit: (result: {
    type: WidgetType;
    config: WidgetConfig;
    title: string;
  }) => void | Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<WidgetFormState>(initial);
  const [filterOpen, setFilterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<WidgetFormState>) => setForm((f) => ({ ...f, ...patch }));

  const { kind, source } = form;
  const type = widgetTypeFor(kind, source);
  const isChart = kind === "chart";
  const isMetric = isChart && source === "metric";
  const isTable = kind === "table";
  const isNote = kind === "note";

  // tables can't show metrics — bounce back to logs if user switches to table
  useEffect(() => {
    if (kind === "table" && source === "metric") update({ source: "logs" });
  }, [kind, source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const config = useMemo(() => buildWidgetConfig(form), [form]);
  const generatedTitle = useMemo(
    () =>
      generateTitle({
        kind,
        source,
        metricName: form.metricName,
        groupBy: form.groupBy,
        attrs: form.attrs,
        markdown: form.markdown,
      }),
    [kind, source, form.metricName, form.groupBy, form.attrs, form.markdown],
  );
  const title = mode === "edit" && existingTitle ? existingTitle : generatedTitle;

  const previewWidget = useMemo<Widget>(
    () => ({
      id: "__preview__",
      dashboardId: "__preview__",
      type,
      title,
      config,
      layout: defaultLayoutFor(type),
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    [type, title, config],
  );

  const disabled = (isMetric && !form.metricName) || (isNote && !form.markdown.trim());

  const submit = async () => {
    if (disabled) return;
    setError(null);
    try {
      // The parent's onSubmit awaits its mutation and only closes the modal on
      // success — so a failed save keeps the form open with the error shown
      // instead of becoming an unhandled rejection.
      await onSubmit({ type, config, title });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save widget");
    }
  };

  const sourceOptions = isChart
    ? [
        { value: "metric", label: "metric" },
        { value: "traces", label: "traces" },
        { value: "logs", label: "logs" },
      ]
    : [
        { value: "traces", label: "traces" },
        { value: "logs", label: "logs" },
      ];

  // Render through a portal to <body>: dashboard widget tiles are positioned
  // with CSS transforms (react-grid-layout) and clip overflow, which would
  // otherwise trap this `position: fixed` overlay inside a single tile.
  return createPortal(
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
              <Label>{mode === "edit" ? "edit widget" : "add widget"}</Label>
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

          {/* Widget kind as pill tabs, mirroring the settings tab bar. */}
          <div className="mb-5">
            <PillToggle
              value={kind}
              options={[
                { value: "chart", label: "Chart" },
                { value: "table", label: "Table" },
                { value: "note", label: "Note" },
              ]}
              onChange={(v) => update({ kind: v as WidgetFormState["kind"] })}
            />
          </div>

          <div className="space-y-4">
            {!isNote && (
              <SettingsCard>
                <SettingsRow
                  title="Source"
                  description="Where this widget pulls its data from"
                  control={
                    <PillToggle
                      value={source}
                      options={sourceOptions}
                      onChange={(v) => update({ source: v as WidgetFormState["source"] })}
                    />
                  }
                />

                {isMetric && (
                  <SettingsRow title="Metric" description="The metric series to chart">
                    <MetricNamePicker
                      projectId={projectId}
                      range={range}
                      value={form.metricName}
                      onChange={(v) => update({ metricName: v })}
                    />
                  </SettingsRow>
                )}

                {isMetric && (
                  <SettingsRow
                    title="Aggregation"
                    description="How points combine within each bucket"
                    control={
                      <PillToggle
                        size="sm"
                        value={form.aggregation}
                        options={["auto", ...METRIC_AGGREGATIONS].map((a) => ({
                          value: a,
                          label: a,
                        }))}
                        onChange={(v) =>
                          update({ aggregation: v as WidgetFormState["aggregation"] })
                        }
                      />
                    }
                  />
                )}

                {isChart && (
                  <SettingsRow
                    title="Group by"
                    description="Split into one series per attribute value"
                    control={
                      <div className="w-52">
                        <GroupBySelect
                          projectId={projectId}
                          range={range}
                          source={source === "metric" ? undefined : source}
                          value={form.groupBy}
                          onChange={(g) => update({ groupBy: g })}
                          shortcut={false}
                          triggerLabel=""
                        />
                      </div>
                    }
                  />
                )}

                {isChart && form.groupBy && (
                  <SettingsRow
                    title="Top series"
                    description="Remaining groups roll into “Other”"
                    control={
                      <div className="w-24">
                        <Input
                          type="number"
                          min={1}
                          max={50}
                          step={1}
                          value={form.seriesLimit}
                          onChange={(e) =>
                            update({
                              seriesLimit: Math.max(1, Math.min(50, Number(e.target.value) || 10)),
                            })
                          }
                        />
                      </div>
                    }
                  />
                )}

                {isTable && (
                  <SettingsRow
                    title="Row limit"
                    description="Maximum rows shown in the table"
                    control={
                      <div className="w-24">
                        <Input
                          type="number"
                          min={10}
                          max={500}
                          step={10}
                          value={form.rowLimit}
                          onChange={(e) =>
                            update({
                              rowLimit: Math.max(10, Math.min(500, Number(e.target.value) || 50)),
                            })
                          }
                        />
                      </div>
                    }
                  />
                )}

                <SettingsRow title="Filters" description="Limit to matching resource attributes">
                  <div className="flex flex-wrap items-center gap-2">
                    {form.attrs.map((a, i) => (
                      <button
                        type="button"
                        key={`${a.key}=${a.value}-${i}`}
                        onClick={() => update({ attrs: form.attrs.filter((_, j) => j !== i) })}
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
                          source={source === "metric" ? undefined : source}
                          existing={form.attrs}
                          onClose={() => setFilterOpen(false)}
                          onPick={(f) => {
                            if (f.kind === "attr") {
                              update({ attrs: [...form.attrs, { key: f.key, value: f.value }] });
                            }
                            setFilterOpen(false);
                          }}
                        />
                      )}
                    </div>
                  </div>
                </SettingsRow>
              </SettingsCard>
            )}

            {isChart && (
              <SettingsCard>
                <SettingsRow
                  title="Chart type"
                  control={
                    <PillToggle
                      value={form.chartType ?? defaultChartType(type)}
                      options={[
                        { value: "line", label: "Line" },
                        { value: "bar", label: "Bar" },
                      ]}
                      onChange={(v) => update({ chartType: v as WidgetFormState["chartType"] })}
                    />
                  }
                />
                <SettingsRow
                  title="Value unit"
                  description="Scales axis, tooltip & legend (e.g. 15000 ms → 15s)"
                  control={
                    <PillToggle
                      size="sm"
                      value={form.unit}
                      options={WIDGET_UNITS.map((u) => ({
                        value: u,
                        label: WIDGET_UNIT_LABELS[u],
                      }))}
                      onChange={(v) => update({ unit: v as WidgetFormState["unit"] })}
                    />
                  }
                />
                <SettingsRow
                  title="X-axis markers"
                  control={
                    <Toggle
                      label="X-axis markers"
                      checked={form.showXAxis}
                      onChange={(v) => update({ showXAxis: v })}
                    />
                  }
                />
                <SettingsRow
                  title="Y-axis markers"
                  control={
                    <Toggle
                      label="Y-axis markers"
                      checked={form.showYAxis}
                      onChange={(v) => update({ showYAxis: v })}
                    />
                  }
                />
                <SettingsRow
                  title="Legend"
                  description="Show a key of series names and values"
                  control={
                    <Toggle
                      label="Legend"
                      checked={form.showLegend}
                      onChange={(v) => update({ showLegend: v })}
                    />
                  }
                />
                {form.showLegend && (
                  <SettingsRow
                    title="Legend position"
                    control={
                      <PillToggle
                        value={form.legendPosition}
                        options={[
                          { value: "side", label: "Side" },
                          { value: "bottom", label: "Bottom" },
                        ]}
                        onChange={(v) =>
                          update({ legendPosition: v as WidgetFormState["legendPosition"] })
                        }
                      />
                    }
                  />
                )}
              </SettingsCard>
            )}

            {isNote && (
              <SettingsCard>
                <SettingsRow
                  title="Markdown"
                  description="Rendered with headings, bullets, and inline code"
                >
                  <textarea
                    value={form.markdown}
                    onChange={(e) => update({ markdown: e.target.value })}
                    className="min-h-40 w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
                  />
                </SettingsRow>
              </SettingsCard>
            )}
          </div>

          <div className="mt-6">
            <Label>preview</Label>
            <div className="mt-3 h-[260px] rounded-lg border border-border bg-surface-1 p-4">
              {isMetric && !form.metricName ? (
                <div className="flex h-full items-center justify-center font-mono text-[11px] text-subtle">
                  pick a metric to preview
                </div>
              ) : isNote && !form.markdown.trim() ? (
                <div className="flex h-full items-center justify-center font-mono text-[11px] text-subtle">
                  write a note to preview
                </div>
              ) : (
                <WidgetBody projectId={projectId} range={range} widget={previewWidget} />
              )}
            </div>
          </div>

          {error && (
            <div className="mt-4 text-[12px] text-danger" role="alert">
              {error}
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            <Btn variant="ghost" size="sm" onClick={onClose}>
              cancel
            </Btn>
            <Btn size="sm" onClick={submit} loading={submitting} disabled={disabled}>
              {mode === "edit" ? "save changes" : "add widget"}
            </Btn>
          </div>
        </Tile>
      </div>
    </div>,
    document.body,
  );
}

// Switch toggle matching the settings rows (see Settings.tsx Toggle). The row
// title is only a visual sibling, so `label` is required to give the switch an
// accessible name (role="switch" otherwise reads as an unnamed control).
function Toggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
        checked ? "border-accent bg-accent" : "border-border bg-surface-3"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-accent-ink transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
