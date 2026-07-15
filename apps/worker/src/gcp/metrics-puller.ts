import { MetricReadBudget } from "./metric-budget.js";

export const CURATED_GCP_METRIC_TYPES = [
  "compute.googleapis.com/instance/cpu/utilization",
  "run.googleapis.com/container/cpu/utilizations",
  "run.googleapis.com/request_count",
  "cloudsql.googleapis.com/database/cpu/utilization",
  "loadbalancing.googleapis.com/https/request_count",
  "pubsub.googleapis.com/subscription/num_undelivered_messages",
] as const;

const GCP_METRICS_VISIBILITY_LAG_MS = 10 * 60 * 1000;
const GCP_METRICS_CATCH_UP_WINDOW_MS = 20 * 60 * 1000;

type GcpDistribution = {
  count?: string;
  mean?: number;
  range?: { min?: number; max?: number };
  bucketOptions?: {
    linearBuckets?: { numFiniteBuckets?: number; width?: number; offset?: number };
    exponentialBuckets?: {
      numFiniteBuckets?: number;
      growthFactor?: number;
      scale?: number;
    };
    explicitBuckets?: { bounds?: number[] };
  };
  bucketCounts?: string[];
};

type TimeSeriesPoint = {
  interval?: { startTime?: string; endTime?: string };
  value?: {
    doubleValue?: number;
    int64Value?: string;
    boolValue?: boolean;
    distributionValue?: GcpDistribution;
  };
};

export type GcpTimeSeries = {
  metric?: { type?: string; labels?: Record<string, string> };
  resource?: { type?: string; labels?: Record<string, string> };
  metricKind?: "GAUGE" | "DELTA" | "CUMULATIVE" | string;
  valueType?: string;
  points?: TimeSeriesPoint[];
};

export type GcpMetricConnection = {
  id: string;
  projectId: string;
  gcpProjectId: string;
  metricsCursors: Record<string, Date>;
  metricsBudgetMonth: string | null;
  metricsSeriesRead: number;
  ingestKey: string | null;
};

export type GcpMetricsPullerStore = {
  listConnected(): Promise<GcpMetricConnection[]>;
  reserveBudget(
    id: string,
    reservation: { month: string; requested: number; monthlyLimit: number },
  ): Promise<number>;
  refundBudget(id: string, refund: { month: string; series: number }): Promise<void>;
  saveCursors(id: string, cursors: Record<string, Date>): Promise<void>;
};

export type GcpMonitoringReader = {
  listTimeSeries(input: {
    gcpProjectId: string;
    metricType: string;
    startTime: Date;
    endTime: Date;
    pageSize: number;
    pageToken?: string;
  }): Promise<{ timeSeries: GcpTimeSeries[]; nextPageToken?: string }>;
};

export async function runGcpMetricsPullOnce(input: {
  store: GcpMetricsPullerStore;
  monitoring: GcpMonitoringReader;
  forward(input: { payload: unknown; ingestKey: string }): Promise<boolean>;
  monthlySeriesLimit: number;
  now?: () => Date;
}): Promise<{ connections: number; seriesRead: number; pointsForwarded: number; errors: number }> {
  const now = input.now ?? (() => new Date());
  const stats = { connections: 0, seriesRead: 0, pointsForwarded: 0, errors: 0 };

  for (const connection of await input.store.listConnected()) {
    stats.connections += 1;
    if (!connection.ingestKey) {
      stats.errors += 1;
      continue;
    }
    try {
      const endTime = now();
      const earliest = new Date(endTime.getTime() - 20 * 60 * 1000);
      const month = MetricReadBudget.restore({
        month: null,
        seriesRead: 0,
        monthlyLimit: input.monthlySeriesLimit,
        now: endTime,
      }).month;
      const visibilityWatermark = new Date(endTime.getTime() - GCP_METRICS_VISIBILITY_LAG_MS);
      const deliveredCursors: Record<string, Date> = {};
      let deliveryFailed = false;

      outer: for (const metricType of CURATED_GCP_METRIC_TYPES) {
        const metricCursor = connection.metricsCursors[metricType] ?? null;
        const startTime = metricCursor
          ? new Date(metricCursor.getTime() - GCP_METRICS_VISIBILITY_LAG_MS)
          : earliest;
        const metricEndTime = metricCursor
          ? new Date(
              Math.min(endTime.getTime(), metricCursor.getTime() + GCP_METRICS_CATCH_UP_WINDOW_MS),
            )
          : endTime;
        let pageToken: string | undefined;
        do {
          // The store serializes this reservation on the connection row. That
          // makes the ceiling hold even if multiple worker processes overlap.
          const pageSize = await input.store.reserveBudget(connection.id, {
            month,
            requested: 1_000,
            monthlyLimit: input.monthlySeriesLimit,
          });
          if (pageSize === 0) {
            // Do not checkpoint a partially paginated metric. When the monthly
            // budget resets, replaying its delivered pages is safer than
            // skipping series that were behind the unconsumed page token.
            Reflect.deleteProperty(deliveredCursors, metricType);
            break outer;
          }
          // Reserve the worst-case returned-series charge before making the
          // external call. If persistence fails, no request is sent. Refund
          // unused capacity afterward; a failed refund only under-uses the cap.
          let page: Awaited<ReturnType<GcpMonitoringReader["listTimeSeries"]>>;
          try {
            page = await input.monitoring.listTimeSeries({
              gcpProjectId: connection.gcpProjectId,
              metricType,
              startTime,
              endTime: metricEndTime,
              pageSize,
              ...(pageToken ? { pageToken } : {}),
            });
          } catch (error) {
            await input.store.refundBudget(connection.id, { month, series: pageSize });
            throw error;
          }
          if (page.timeSeries.length > pageSize) {
            throw new Error("Cloud Monitoring returned more time series than requested");
          }
          const unusedReservation = pageSize - page.timeSeries.length;
          if (unusedReservation > 0) {
            await input.store.refundBudget(connection.id, {
              month,
              series: unusedReservation,
            });
          }
          stats.seriesRead += page.timeSeries.length;
          // Keep memory and the intake payload bounded to one Monitoring page.
          // The cursor commits only after every delivered page succeeds, so a
          // partial failure remains at-least-once instead of dropping data.
          const fresh = filterPointsThroughWatermark(
            page.timeSeries,
            metricCursor,
            visibilityWatermark,
          );
          const points = fresh.reduce((sum, series) => sum + (series.points?.length ?? 0), 0);
          if (points > 0) {
            const delivered = await input.forward({
              payload: gcpTimeSeriesToOtlp(fresh, connection.gcpProjectId),
              ingestKey: connection.ingestKey,
            });
            if (!delivered) {
              stats.errors += 1;
              deliveryFailed = true;
              break outer;
            }
            stats.pointsForwarded += points;
            const pageDeliveredThrough = latestPointTime(fresh);
            if (
              pageDeliveredThrough &&
              (!deliveredCursors[metricType] || pageDeliveredThrough > deliveredCursors[metricType])
            ) {
              deliveredCursors[metricType] = pageDeliveredThrough;
            }
          }
          pageToken = page.nextPageToken;
        } while (pageToken);

        // A fully scanned historical window is safe to checkpoint even when
        // it contained no samples. This lets quiet metric types catch up after
        // an outage without skipping the interval or replaying it forever.
        if (
          metricCursor &&
          metricEndTime <= visibilityWatermark &&
          (!deliveredCursors[metricType] || metricEndTime > deliveredCursors[metricType])
        ) {
          deliveredCursors[metricType] = metricEndTime;
        }
      }

      if (deliveryFailed) continue;
      if (Object.keys(deliveredCursors).length > 0) {
        await input.store.saveCursors(connection.id, deliveredCursors);
      }
    } catch {
      stats.errors += 1;
    }
  }
  return stats;
}

function filterPointsThroughWatermark(
  series: GcpTimeSeries[],
  cursor: Date | null,
  visibilityWatermark: Date,
): GcpTimeSeries[] {
  const cursorMs = cursor?.getTime() ?? Number.NEGATIVE_INFINITY;
  const watermarkMs = visibilityWatermark.getTime();
  return series.flatMap((timeSeries) => {
    const points = (timeSeries.points ?? []).filter((point) => {
      const timestamp = Date.parse(point.interval?.endTime ?? "");
      return Number.isFinite(timestamp) && timestamp > cursorMs && timestamp <= watermarkMs;
    });
    return points.length > 0 ? [{ ...timeSeries, points }] : [];
  });
}

function latestPointTime(series: GcpTimeSeries[]): Date | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const timeSeries of series) {
    for (const point of timeSeries.points ?? []) {
      const timestamp = Date.parse(point.interval?.endTime ?? "");
      if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
    }
  }
  return Number.isFinite(latest) ? new Date(latest) : null;
}

export function gcpTimeSeriesToOtlp(series: GcpTimeSeries[], gcpProjectId: string) {
  return {
    resourceMetrics: series.map((timeSeries) => {
      const resourceLabels = timeSeries.resource?.labels ?? {};
      const metricLabels = timeSeries.metric?.labels ?? {};
      const attributes = Object.entries(metricLabels).map(([key, item]) => ({
        key: `gcp.metric.label.${key}`,
        value: { stringValue: item },
      }));
      const isDistribution = timeSeries.valueType === "DISTRIBUTION";
      const dataPoints = isDistribution
        ? (timeSeries.points ?? []).flatMap((point) => {
            if (!point.interval?.endTime) return [];
            const distribution = histogramPoint(point.value?.distributionValue);
            if (!distribution) return [];
            return [
              {
                ...distribution,
                ...pointMetadata(point, attributes),
              },
            ];
          })
        : (timeSeries.points ?? []).flatMap((point) => {
            if (!point.interval?.endTime) return [];
            const value = pointValue(point.value);
            if (!value) return [];
            return [
              {
                ...value,
                ...pointMetadata(point, attributes),
              },
            ];
          });
      const metricName = timeSeries.metric?.type ?? "gcp.unknown";
      const data = isDistribution
        ? {
            histogram: {
              dataPoints,
              aggregationTemporality: timeSeries.metricKind === "DELTA" ? 1 : 2,
            },
          }
        : timeSeries.metricKind === "GAUGE"
          ? { gauge: { dataPoints } }
          : {
              sum: {
                dataPoints,
                aggregationTemporality: timeSeries.metricKind === "DELTA" ? 1 : 2,
                isMonotonic: timeSeries.metricKind === "CUMULATIVE",
              },
            };
      return {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName(timeSeries) } },
            { key: "telemetry.source", value: { stringValue: "gcp" } },
            { key: "cloud.provider", value: { stringValue: "gcp" } },
            { key: "cloud.account.id", value: { stringValue: gcpProjectId } },
            { key: "gcp.project.id", value: { stringValue: gcpProjectId } },
            {
              key: "gcp.resource.type",
              value: { stringValue: timeSeries.resource?.type ?? "" },
            },
            ...Object.entries(resourceLabels).map(([key, item]) => ({
              key: `gcp.resource.label.${key}`,
              value: { stringValue: item },
            })),
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "gcp.cloud_monitoring" },
            metrics: [{ name: metricName, ...data }],
          },
        ],
      };
    }),
  };
}

function pointValue(
  value: TimeSeriesPoint["value"],
): { asDouble: number } | { asInt: string } | null {
  if (typeof value?.doubleValue === "number") return { asDouble: value.doubleValue };
  if (typeof value?.int64Value === "string") return { asInt: value.int64Value };
  if (typeof value?.boolValue === "boolean") return { asInt: value.boolValue ? "1" : "0" };
  return null;
}

function pointMetadata(
  point: TimeSeriesPoint,
  attributes: Array<{ key: string; value: { stringValue: string } }>,
) {
  const endTime = point.interval?.endTime;
  if (!endTime) throw new Error("GCP metric point is missing its end time");
  return {
    timeUnixNano: timestampToNanos(endTime),
    ...(point.interval?.startTime
      ? { startTimeUnixNano: timestampToNanos(point.interval.startTime) }
      : {}),
    attributes,
  };
}

function histogramPoint(value: GcpDistribution | undefined) {
  if (!value?.count || !value.bucketOptions || !value.bucketCounts) return null;
  const explicitBounds = distributionBounds(value.bucketOptions);
  if (!explicitBounds) return null;
  const bucketCounts = [...value.bucketCounts];
  while (bucketCounts.length < explicitBounds.length + 1) bucketCounts.push("0");
  if (bucketCounts.length !== explicitBounds.length + 1) return null;
  const count = Number(value.count);
  const sum = typeof value.mean === "number" && Number.isFinite(count) ? value.mean * count : null;
  return {
    count: value.count,
    ...(sum === null ? {} : { sum }),
    ...(typeof value.range?.min === "number" ? { min: value.range.min } : {}),
    ...(typeof value.range?.max === "number" ? { max: value.range.max } : {}),
    bucketCounts,
    explicitBounds,
  };
}

function distributionBounds(
  options: NonNullable<GcpDistribution["bucketOptions"]>,
): number[] | null {
  if (options?.explicitBuckets?.bounds) return options.explicitBuckets.bounds;
  const linear = options?.linearBuckets;
  const linearCount = linear?.numFiniteBuckets;
  const linearWidth = linear?.width;
  const linearOffset = linear?.offset;
  if (
    typeof linearCount === "number" &&
    linearCount > 0 &&
    typeof linearWidth === "number" &&
    typeof linearOffset === "number"
  ) {
    return Array.from(
      { length: linearCount + 1 },
      (_, index) => linearOffset + linearWidth * index,
    );
  }
  const exponential = options?.exponentialBuckets;
  const exponentialCount = exponential?.numFiniteBuckets;
  const growthFactor = exponential?.growthFactor;
  const scale = exponential?.scale;
  if (
    typeof exponentialCount === "number" &&
    exponentialCount > 0 &&
    typeof growthFactor === "number" &&
    typeof scale === "number"
  ) {
    return Array.from(
      { length: exponentialCount + 1 },
      (_, index) => scale * growthFactor ** index,
    );
  }
  return null;
}

function timestampToNanos(value: string): string {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? String(BigInt(millis) * 1_000_000n) : "0";
}

function serviceName(series: GcpTimeSeries): string {
  const labels = series.resource?.labels ?? {};
  return (
    labels.service_name ??
    labels.container_name ??
    labels.database_id ??
    labels.instance_id ??
    series.resource?.type ??
    "gcp"
  );
}
