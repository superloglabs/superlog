import { MetricReadBudget } from "./metric-budget.js";

export const CURATED_GCP_METRIC_TYPES = [
  "compute.googleapis.com/instance/cpu/utilization",
  "run.googleapis.com/container/cpu/utilizations",
  "run.googleapis.com/request_count",
  "cloudsql.googleapis.com/database/cpu/utilization",
  "loadbalancing.googleapis.com/https/request_count",
  "pubsub.googleapis.com/subscription/num_undelivered_messages",
] as const;

type TimeSeriesPoint = {
  interval?: { startTime?: string; endTime?: string };
  value?: { doubleValue?: number; int64Value?: string; boolValue?: boolean };
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
  metricsCursor: Date | null;
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
  saveCursor(id: string, cursor: Date): Promise<void>;
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
      const overlapStart = connection.metricsCursor
        ? new Date(connection.metricsCursor.getTime() - 10 * 60 * 1000)
        : earliest;
      const startTime = overlapStart < earliest ? earliest : overlapStart;
      const month = MetricReadBudget.restore({
        month: null,
        seriesRead: 0,
        monthlyLimit: input.monthlySeriesLimit,
        now: endTime,
      }).month;
      const collected: GcpTimeSeries[] = [];

      outer: for (const metricType of CURATED_GCP_METRIC_TYPES) {
        let pageToken: string | undefined;
        do {
          // The store serializes this reservation on the connection row. That
          // makes the ceiling hold even if multiple worker processes overlap.
          const pageSize = await input.store.reserveBudget(connection.id, {
            month,
            requested: 1_000,
            monthlyLimit: input.monthlySeriesLimit,
          });
          if (pageSize === 0) break outer;
          // Reserve the worst-case returned-series charge before making the
          // external call. If persistence fails, no request is sent. Refund
          // unused capacity afterward; a failed refund only under-uses the cap.
          const page = await input.monitoring.listTimeSeries({
            gcpProjectId: connection.gcpProjectId,
            metricType,
            startTime,
            endTime,
            pageSize,
            ...(pageToken ? { pageToken } : {}),
          });
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
          collected.push(...page.timeSeries);
          pageToken = page.nextPageToken;
        } while (pageToken);
      }

      const points = collected.reduce((sum, series) => sum + (series.points?.length ?? 0), 0);
      const delivered =
        points === 0 ||
        (await input.forward({
          payload: gcpTimeSeriesToOtlp(collected, connection.gcpProjectId),
          ingestKey: connection.ingestKey,
        }));
      if (!delivered) {
        stats.errors += 1;
        continue;
      }
      stats.pointsForwarded += points;
      await input.store.saveCursor(connection.id, endTime);
    } catch {
      stats.errors += 1;
    }
  }
  return stats;
}

export function gcpTimeSeriesToOtlp(series: GcpTimeSeries[], gcpProjectId: string) {
  return {
    resourceMetrics: series.map((timeSeries) => {
      const resourceLabels = timeSeries.resource?.labels ?? {};
      const metricLabels = timeSeries.metric?.labels ?? {};
      const dataPoints = (timeSeries.points ?? []).flatMap((point) => {
        const value = pointValue(point.value);
        if (!value || !point.interval?.endTime) return [];
        return [
          {
            ...value,
            timeUnixNano: timestampToNanos(point.interval.endTime),
            ...(point.interval.startTime
              ? { startTimeUnixNano: timestampToNanos(point.interval.startTime) }
              : {}),
            attributes: Object.entries(metricLabels).map(([key, item]) => ({
              key: `gcp.metric.label.${key}`,
              value: { stringValue: item },
            })),
          },
        ];
      });
      const metricName = timeSeries.metric?.type ?? "gcp.unknown";
      const data =
        timeSeries.metricKind === "GAUGE"
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
