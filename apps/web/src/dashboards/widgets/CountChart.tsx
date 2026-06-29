import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { EChartsOption, SetOptionOpts } from "echarts";
import type { BarSeriesOption, LineSeriesOption } from "echarts/charts";
import type * as EChartsCore from "echarts/core";
import { forwardRef, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ExploreRange } from "../../api.ts";
import type { ChartType, LegendPosition } from "../types.ts";
import { echarts } from "./echarts-setup.ts";
import {
  type BucketGrid,
  type ChartSeries,
  type GroupedRow,
  buildTopNSeries,
  parseStepMs,
} from "./series-topn.ts";
import { type SummaryAgg, type WidgetUnit, formatValue, summarizeSeries } from "./widget-format.ts";

type SeriesChartProps<T extends GroupedRow> = {
  rows: T[];
  /** Per-row value accessor — `r.count` for count series, `r.value` for metrics. */
  value: (row: T) => number;
  chartType: ChartType;
  limit: number;
  /**
   * Query window. Pins the x-axis to the selected range (instead of the data
   * extent, which lies about sparse data) and, for bar charts, zero-fills the
   * bucket grid so bars are always one server bucket wide.
   */
  range?: ExploreRange;
  /** Server bucket step ("5 MINUTE") from the series response. */
  step?: string;
  showXAxis?: boolean;
  showYAxis?: boolean;
  showLegend: boolean;
  legendPosition: LegendPosition;
  /** How to render values on the axis, in the tooltip, and in the legend. */
  unit?: WidgetUnit;
  /**
   * Aggregation the legend headline mirrors: "sum" for count widgets, the
   * widget's own aggregation for metric widgets (the window total of per-bucket
   * sums is meaningless for a gauge metric, so the headline matches the chart).
   */
  legendAgg?: SummaryAgg;
  /** Optional horizontal reference line (e.g. an alert threshold). */
  threshold?: number;
  thresholdLabel?: string;
};

type TimeseriesData = ChartSeries & {
  color: string;
};

type TooltipRow = {
  name: string;
  value: number;
  color: string;
};

type TooltipState = {
  ts: number;
  rows: TooltipRow[];
  hiddenCount: number;
};

type ChartEvents = {
  updateaxispointer: (params: unknown) => void;
  globalout: () => void;
};

const CHART_COLORS = ["#4290F0", "#EEB720", "#E8649D", "#8D58EE", "#50C3B6", "#D37536"];
const FIRST_CHART_COLOR = "#4290F0";
const OTHER_COLOR = "#878787";
const AXIS_LABEL_COLOR = "rgba(138, 138, 143, 0.5)";
const GRID_LINE_COLOR = "rgba(255, 255, 255, 0.07)";
const THRESHOLD_COLOR = "#E8649D";

const timestampFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function CountChart<T extends GroupedRow>({
  rows,
  value,
  chartType,
  limit,
  range,
  step,
  showXAxis = true,
  showYAxis = false,
  showLegend,
  legendPosition,
  unit = "none",
  legendAgg = "sum",
  threshold,
  thresholdLabel,
}: SeriesChartProps<T>) {
  const window = useMemo(() => {
    const sinceMs = range ? Date.parse(range.since) : Number.NaN;
    const untilMs = range ? Date.parse(range.until) : Number.NaN;
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) {
      return undefined;
    }
    return { sinceMs, untilMs };
  }, [range]);

  // Bars only: lines connect actual samples, and zero-filling them would draw
  // false dips wherever the bucket step is finer than the export interval.
  const grid = useMemo<BucketGrid | undefined>(() => {
    if (chartType !== "bar" || !window) return undefined;
    const stepMs = parseStepMs(step);
    return stepMs ? { ...window, stepMs } : undefined;
  }, [chartType, window, step]);

  const allSeries = useMemo(
    () =>
      buildTopNSeries(rows, value, limit, grid).map((series, index) => ({
        ...series,
        color: series.isOther
          ? OTHER_COLOR
          : (CHART_COLORS[index % CHART_COLORS.length] ?? FIRST_CHART_COLOR),
      })),
    [rows, value, limit, grid],
  );
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setHiddenSeries((current) => {
      const names = new Set(allSeries.map((series) => series.name));
      const next = new Set([...current].filter((name) => names.has(name)));
      return next.size === current.size ? current : next;
    });
  }, [allSeries]);

  const visibleSeries = useMemo(
    () => allSeries.filter((series) => !hiddenSeries.has(series.name)),
    [allSeries, hiddenSeries],
  );

  const toggleSeries = (name: string) => {
    setHiddenSeries((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const chart = (
    <KumoLikeTimeseriesChart
      data={visibleSeries}
      type={chartType}
      height="100%"
      xMin={window?.sinceMs}
      xMax={window?.untilMs}
      showXAxis={showXAxis}
      showYAxis={showYAxis}
      unit={unit}
      threshold={threshold}
      thresholdLabel={thresholdLabel}
      optionUpdateBehavior={{ notMerge: true, lazyUpdate: true }}
    />
  );

  if (!showLegend || allSeries.length <= 1) {
    return <div className="h-full min-h-0">{chart}</div>;
  }

  if (legendPosition === "bottom") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">{chart}</div>
        <SeriesLegend
          series={allSeries}
          hiddenSeries={hiddenSeries}
          onToggleSeries={toggleSeries}
          position="bottom"
          unit={unit}
          legendAgg={legendAgg}
        />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_180px]">
      <div className="min-h-0 min-w-0">{chart}</div>
      <SeriesLegend
        series={allSeries}
        hiddenSeries={hiddenSeries}
        onToggleSeries={toggleSeries}
        position="side"
        unit={unit}
        legendAgg={legendAgg}
      />
    </div>
  );
}

function KumoLikeTimeseriesChart({
  data,
  type,
  height,
  xMin,
  xMax,
  showXAxis,
  showYAxis,
  unit,
  threshold,
  thresholdLabel,
  optionUpdateBehavior,
}: {
  data: TimeseriesData[];
  type: ChartType;
  height: number | string;
  xMin?: number;
  xMax?: number;
  showXAxis: boolean;
  showYAxis: boolean;
  unit: WidgetUnit;
  threshold?: number;
  thresholdLabel?: string;
  optionUpdateBehavior?: SetOptionOpts;
}) {
  const chartRef = useRef<EChartsCore.ECharts | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [tooltipState, setTooltipState] = useState<TooltipState | null>(null);

  const options = useMemo(() => {
    const transformSeries: Array<LineSeriesOption | BarSeriesOption> = [];
    const seriesType =
      type === "bar"
        ? ({ type: "bar", stack: "total" } as const)
        : ({ type: "line", showSymbol: false } as const);

    for (const series of data) {
      transformSeries.push({
        data: series.data,
        color: series.color,
        name: series.name,
        emphasis: { focus: "series" },
        ...seriesType,
      });
    }

    // Dashed horizontal reference line (e.g. an alert threshold). Attached to
    // the first series, or a dummy line series when there's no data yet so the
    // threshold still renders.
    if (threshold != null && Number.isFinite(threshold)) {
      const markLine = {
        silent: true,
        symbol: "none" as const,
        data: [{ yAxis: threshold }],
        lineStyle: { type: "dashed" as const, color: THRESHOLD_COLOR, width: 1 },
        label: {
          show: true,
          position: "insideEndTop" as const,
          formatter: thresholdLabel ?? `threshold ${formatValue(threshold, unit)}`,
          color: THRESHOLD_COLOR,
          fontSize: 10,
        },
      };
      if (transformSeries[0]) transformSeries[0].markLine = markLine;
      else transformSeries.push({ type: "line", data: [], markLine });
    }

    return {
      aria: { enabled: true },
      tooltip: {
        trigger: "axis",
        showContent: false,
        axisPointer: { type: "shadow" },
      },
      backgroundColor: "transparent",
      toolbox: { show: false },
      xAxis: {
        type: "time",
        // Pin the axis to the query window so sparse data sits in honest
        // empty space instead of stretching to fill the chart.
        min: xMin,
        max: xMax,
        // Vertical gridlines at the time ticks, matching the horizontal ones, so
        // a window with no (or sparse) data still reads as a grid all the way to
        // the tile edge rather than a bare panel.
        splitLine: {
          show: true,
          lineStyle: { type: "dashed", width: 1, color: GRID_LINE_COLOR },
        },
        axisLine: { show: false },
        axisTick: { show: showXAxis },
        axisLabel: {
          show: showXAxis,
          color: AXIS_LABEL_COLOR,
          fontSize: 11,
          hideOverlap: true,
        },
        splitNumber: 5,
      },
      yAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: showYAxis },
        axisLabel: {
          show: showYAxis,
          color: AXIS_LABEL_COLOR,
          fontSize: 11,
          margin: 10,
          formatter: (value: number) => formatValue(value, unit),
        },
        splitLine: {
          show: true,
          lineStyle: { type: "dashed", width: 1, color: GRID_LINE_COLOR },
        },
        splitNumber: 3,
      },
      grid: {
        left: showYAxis ? 34 : 10,
        right: 14,
        top: 12,
        bottom: showXAxis ? 24 : 10,
      },
      series: transformSeries,
    } satisfies EChartsOption;
  }, [data, type, xMin, xMax, showXAxis, showYAxis, unit, threshold, thresholdLabel]);

  const events = useMemo<Partial<ChartEvents>>(
    () => ({
      updateaxispointer: (params: unknown) => {
        const ts = getAxisPointerTimestamp(params);
        if (ts == null) return;

        const seenNames = new Set<string>();
        const rows: TooltipRow[] = [];
        for (const series of dataRef.current) {
          if (seenNames.has(series.name)) continue;
          seenNames.add(series.name);
          const value = findNearest(series.data, ts);
          if (value != null) rows.push({ name: series.name, value, color: series.color });
        }

        rows.sort((a, b) => b.value - a.value);
        const maxItems = 10;
        const nextState = {
          ts,
          rows: rows.slice(0, maxItems),
          hiddenCount: Math.max(0, rows.length - maxItems),
        };

        setTooltipState((previous) =>
          isSameTooltipState(previous, nextState) ? previous : nextState,
        );
      },
      globalout: () => setTooltipState(null),
    }),
    [],
  );

  const tooltipOpen = tooltipState !== null;

  return (
    <TooltipPrimitive.Root open={tooltipOpen} trackCursorAxis="both">
      <TooltipPrimitive.Trigger
        render={<div ref={containerRef} className="relative h-full min-h-0 w-full" />}
      >
        <Chart
          ref={chartRef}
          options={options}
          height={height}
          onEvents={events}
          optionUpdateBehavior={optionUpdateBehavior}
        />
      </TooltipPrimitive.Trigger>
      {tooltipOpen && (
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner
            side="right"
            align="start"
            sideOffset={12}
            collisionAvoidance={{ side: "flip", align: "shift" }}
            collisionBoundary="clipping-ancestors"
            collisionPadding={8}
          >
            <TooltipPrimitive.Popup className="rounded-lg border border-border-strong bg-surface px-2 py-2 text-fg shadow-2xl shadow-black/30">
              <TooltipContent state={tooltipState} unit={unit} />
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      )}
    </TooltipPrimitive.Root>
  );
}

const Chart = forwardRef<
  EChartsCore.ECharts,
  {
    options: EChartsOption;
    height: number | string;
    optionUpdateBehavior?: SetOptionOpts;
    onEvents?: Partial<ChartEvents>;
  }
>(function Chart({ options, height, optionUpdateBehavior, onEvents }, ref) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsCore.ECharts | null>(null);
  const handlersRef = useRef<Partial<ChartEvents>>({});
  const wrappersRef = useRef<Record<string, (params: unknown) => void>>({});
  const boundEventsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!elRef.current) return;

    const chart = echarts.init(elRef.current, { color: CHART_COLORS });
    chartRef.current = chart;

    if (typeof ref === "function") ref(chart);
    else if (ref) ref.current = chart;

    return () => {
      for (const event of boundEventsRef.current) {
        const wrapper = wrappersRef.current[event];
        if (wrapper) chart.off(event, wrapper);
      }
      boundEventsRef.current.clear();
      if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
      chartRef.current = null;
      chart.dispose();
    };
  }, [ref]);

  useEffect(() => {
    chartRef.current?.setOption(options, {
      notMerge: false,
      lazyUpdate: true,
      ...optionUpdateBehavior,
    });
  }, [options, optionUpdateBehavior]);

  useEffect(() => {
    handlersRef.current = onEvents ?? {};
  }, [onEvents]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const nextBound = new Set<string>();
    for (const [event, handler] of Object.entries(onEvents ?? {})) {
      if (typeof handler !== "function") continue;
      nextBound.add(event);

      if (!wrappersRef.current[event]) {
        wrappersRef.current[event] = (params: unknown) => {
          const current = handlersRef.current as Record<
            string,
            ((params: unknown) => void) | undefined
          >;
          current[event]?.(params);
        };
      }

      if (!boundEventsRef.current.has(event)) {
        chart.on(event, wrappersRef.current[event]);
      }
    }

    for (const event of boundEventsRef.current) {
      if (nextBound.has(event)) continue;
      const wrapper = wrappersRef.current[event];
      if (wrapper) chart.off(event, wrapper);
    }

    boundEventsRef.current = nextBound;
  }, [onEvents]);

  useEffect(() => {
    const chart = chartRef.current;
    const element = elRef.current;
    if (!chart || !element) return;

    let isInitial = true;
    const observer = new ResizeObserver(() => {
      if (isInitial) {
        isInitial = false;
        return;
      }
      chart.resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={elRef} className="h-full w-full" style={{ height }} role="img" />;
});

Chart.displayName = "Chart";

const TooltipContent = memo(function TooltipContent({
  state,
  unit,
}: {
  state: TooltipState;
  unit: WidgetUnit;
}) {
  const { ts, rows, hiddenCount } = state;
  return (
    <>
      <div className="mb-1 text-xs font-semibold text-fg">{formatTimestamp(ts)}</div>
      {rows.map((row) => (
        <div key={row.name} className="flex items-center justify-between gap-4 py-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: row.color }}
            />
            <span className="truncate text-xs font-medium text-fg" title={row.name}>
              {row.name}
            </span>
          </div>
          <span className="shrink-0 text-xs font-semibold text-fg">
            {formatValue(row.value, unit)}
          </span>
        </div>
      ))}
      {hiddenCount > 0 && <div className="mt-1 text-xs text-subtle">+{hiddenCount} more</div>}
    </>
  );
});

function SeriesLegend({
  series,
  hiddenSeries,
  onToggleSeries,
  position,
  unit,
  legendAgg,
}: {
  series: TimeseriesData[];
  hiddenSeries: Set<string>;
  onToggleSeries: (name: string) => void;
  position: LegendPosition;
  unit: WidgetUnit;
  legendAgg: SummaryAgg;
}) {
  const isBottom = position === "bottom";
  return (
    <div
      className={
        isBottom
          ? "mt-3 max-h-20 overflow-auto border-t border-border pt-3"
          : "ml-3 overflow-auto border-l border-border pl-3"
      }
    >
      <div
        className={isBottom ? "flex flex-wrap items-center gap-x-4 gap-y-2" : "flex flex-col gap-2"}
      >
        {series.map((item) => {
          const inactive = hiddenSeries.has(item.name);
          return (
            <button
              key={item.name}
              type="button"
              className="group inline-flex min-w-0 items-center gap-2 text-left"
              onClick={() => onToggleSeries(item.name)}
              title={item.name}
              aria-pressed={!inactive}
            >
              <span
                className={cx(
                  "inline-block h-2 w-2 shrink-0 rounded-full",
                  inactive && "opacity-40",
                )}
                style={{ backgroundColor: item.color }}
              />
              <span
                className={cx(
                  "min-w-0 truncate text-xs text-muted group-hover:text-fg",
                  inactive && "text-subtle line-through opacity-60",
                )}
              >
                {item.name}
              </span>
              <span
                className={cx(
                  "shrink-0 text-xs font-medium text-fg",
                  inactive && "text-subtle line-through opacity-60",
                )}
              >
                {formatValue(summarizeSeries(item.values, legendAgg), unit)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function findNearest(data: [number, number][], ts: number): number | null {
  if (data.length === 0) return null;
  let lo = 0;
  let hi = data.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const point = data[mid];
    if (point && point[0] < ts) lo = mid + 1;
    else hi = mid;
  }
  const previous = data[lo - 1];
  const current = data[lo];
  if (!current) return null;
  if (lo > 0 && previous && Math.abs(previous[0] - ts) < Math.abs(current[0] - ts)) lo--;
  return data[lo]?.[1] ?? null;
}

function isSameTooltipState(previous: TooltipState | null, next: TooltipState): boolean {
  if (
    !previous ||
    previous.ts !== next.ts ||
    previous.hiddenCount !== next.hiddenCount ||
    previous.rows.length !== next.rows.length
  ) {
    return false;
  }
  return previous.rows.every((row, index) => {
    const nextRow = next.rows[index];
    return row.name === nextRow?.name && row.value === nextRow.value && row.color === nextRow.color;
  });
}

function getAxisPointerTimestamp(params: unknown): number | undefined {
  if (!params || typeof params !== "object") return undefined;
  const axesInfo = (params as { axesInfo?: Array<{ value?: unknown }> }).axesInfo;
  const value = axesInfo?.[0]?.value;
  return typeof value === "number" ? value : undefined;
}

function formatTimestamp(value: number): string {
  return timestampFormat.format(new Date(value));
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
