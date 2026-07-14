import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runGcpMetricsPullOnce } from "./metrics-puller.js";

test("the metrics puller forwards and checkpoints only through the visibility watermark", async () => {
  const pageSizes: number[] = [];
  const reservations: Array<{ month: string; requested: number; monthlyLimit: number }> = [];
  const savedCursors: Array<Record<string, Date>> = [];
  const forwarded: unknown[] = [];
  const now = new Date("2026-07-13T12:00:00Z");
  let seriesRead = 99_999_999;

  const stats = await runGcpMetricsPullOnce({
    now: () => now,
    monthlySeriesLimit: 100_000_000,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "superlog-project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {
              "compute.googleapis.com/instance/cpu/utilization": new Date("2026-07-13T11:45:00Z"),
            },
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 99_999_999,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget(_id, reservation) {
        reservations.push(reservation);
        const reserved = Math.min(reservation.requested, reservation.monthlyLimit - seriesRead);
        seriesRead += reserved;
        return reserved;
      },
      async refundBudget(_id, refund) {
        seriesRead -= refund.series;
      },
      async saveCursors(_id, cursors) {
        savedCursors.push(cursors);
      },
    },
    monitoring: {
      async listTimeSeries(input) {
        pageSizes.push(input.pageSize);
        return {
          timeSeries: [
            {
              metric: { type: "compute.googleapis.com/instance/cpu/utilization" },
              resource: {
                type: "gce_instance",
                labels: {
                  project_id: "acme-production",
                  instance_id: "123",
                  zone: "us-central1-a",
                },
              },
              metricKind: "GAUGE",
              valueType: "DOUBLE",
              points: [
                {
                  interval: { endTime: "2026-07-13T11:49:00Z" },
                  value: { doubleValue: 0.41 },
                },
                {
                  interval: { endTime: "2026-07-13T11:59:00Z" },
                  value: { doubleValue: 0.42 },
                },
              ],
            },
          ],
        };
      },
    },
    async forward(input) {
      forwarded.push(input.payload);
      assert.equal(input.ingestKey, "sl_public_test");
      return true;
    },
  });

  assert.deepEqual(pageSizes, [1]);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(reservations, [
    { month: "2026-07", requested: 1_000, monthlyLimit: 100_000_000 },
    { month: "2026-07", requested: 1_000, monthlyLimit: 100_000_000 },
  ]);
  assert.equal(seriesRead, 100_000_000);
  assert.equal(
    savedCursors[0]?.["compute.googleapis.com/instance/cpu/utilization"]?.toISOString(),
    "2026-07-13T11:49:00.000Z",
  );
  assert.deepEqual(stats, { connections: 1, seriesRead: 1, pointsForwarded: 1, errors: 0 });
});

test("paginated Monitoring results are forwarded in bounded page payloads", async () => {
  const forwardedSeriesCounts: number[] = [];
  const savedCursors: Array<Record<string, Date>> = [];
  let seriesRead = 0;
  let monitoringCalls = 0;
  const stats = await runGcpMetricsPullOnce({
    now: () => new Date("2026-07-13T12:00:00Z"),
    monthlySeriesLimit: 2,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {
              "compute.googleapis.com/instance/cpu/utilization": new Date("2026-07-13T11:45:00Z"),
            },
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 0,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget(_id, reservation) {
        const reserved = Math.min(reservation.requested, reservation.monthlyLimit - seriesRead);
        seriesRead += reserved;
        return reserved;
      },
      async refundBudget(_id, refund) {
        seriesRead -= refund.series;
      },
      async saveCursors(_id, cursors) {
        savedCursors.push(cursors);
      },
    },
    monitoring: {
      async listTimeSeries() {
        monitoringCalls += 1;
        const minute = 47 + monitoringCalls;
        return {
          timeSeries: [
            {
              metric: { type: "compute.googleapis.com/instance/cpu/utilization" },
              resource: { type: "gce_instance" },
              metricKind: "GAUGE",
              points: [
                {
                  interval: { endTime: `2026-07-13T11:${minute}:00Z` },
                  value: { doubleValue: 0.4 + monitoringCalls / 10 },
                },
              ],
            },
          ],
          ...(monitoringCalls === 1 ? { nextPageToken: "page-2" } : {}),
        };
      },
    },
    async forward({ payload }) {
      const body = payload as { resourceMetrics: unknown[] };
      forwardedSeriesCounts.push(body.resourceMetrics.length);
      return true;
    },
  });

  assert.deepEqual(forwardedSeriesCounts, [1, 1]);
  assert.equal(
    savedCursors[0]?.["compute.googleapis.com/instance/cpu/utilization"]?.toISOString(),
    "2026-07-13T11:49:00.000Z",
  );
  assert.deepEqual(stats, { connections: 1, seriesRead: 2, pointsForwarded: 2, errors: 0 });
});

test("a faster metric cursor does not hide a later-visible point from a slower metric type", async () => {
  const forwarded: unknown[] = [];
  const savedCursors: Array<Record<string, Date>> = [];
  await runGcpMetricsPullOnce({
    now: () => new Date("2026-07-13T12:00:00Z"),
    monthlySeriesLimit: 10,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {
              "compute.googleapis.com/instance/cpu/utilization": new Date("2026-07-13T11:49:00Z"),
            },
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 0,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget(_id, reservation) {
        return reservation.requested;
      },
      async refundBudget() {},
      async saveCursors(_id, cursors) {
        savedCursors.push(cursors);
      },
    },
    monitoring: {
      async listTimeSeries({ metricType }) {
        if (metricType !== "run.googleapis.com/request_count") return { timeSeries: [] };
        return {
          timeSeries: [
            {
              metric: { type: metricType },
              resource: { type: "cloud_run_revision" },
              metricKind: "DELTA",
              points: [
                {
                  interval: { endTime: "2026-07-13T11:48:00Z" },
                  value: { int64Value: "1" },
                },
              ],
            },
          ],
        };
      },
    },
    async forward({ payload }) {
      forwarded.push(payload);
      return true;
    },
  });

  assert.equal(forwarded.length, 1);
  assert.equal(
    savedCursors[0]?.["run.googleapis.com/request_count"]?.toISOString(),
    "2026-07-13T11:48:00.000Z",
  );
});

test("a failed intake still spends the read budget but does not advance the data cursor", async () => {
  const reservations: number[] = [];
  const savedCursors: Array<Record<string, Date>> = [];
  let remaining = 1;
  await runGcpMetricsPullOnce({
    now: () => new Date("2026-07-13T12:00:00Z"),
    monthlySeriesLimit: 10,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {
              "compute.googleapis.com/instance/cpu/utilization": new Date("2026-07-13T11:45:00Z"),
            },
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 9,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget(_id, reservation) {
        reservations.push(reservation.requested);
        const reserved = Math.min(remaining, reservation.requested);
        remaining -= reserved;
        return reserved;
      },
      async refundBudget() {
        throw new Error("a full page must not be refunded");
      },
      async saveCursors(_id, cursors) {
        savedCursors.push(cursors);
      },
    },
    monitoring: {
      async listTimeSeries() {
        return {
          timeSeries: [
            {
              metric: { type: "compute.googleapis.com/instance/cpu/utilization" },
              resource: { type: "gce_instance", labels: { project_id: "acme-production" } },
              metricKind: "GAUGE",
              points: [
                { interval: { endTime: "2026-07-13T11:49:00Z" }, value: { doubleValue: 0.5 } },
              ],
            },
          ],
        };
      },
    },
    async forward() {
      return false;
    },
  });
  assert.deepEqual(reservations, [1_000]);
  assert.deepEqual(savedCursors, []);
});

test("no paid Monitoring call starts when the atomic database reservation is exhausted", async () => {
  let monitoringCalls = 0;
  await runGcpMetricsPullOnce({
    now: () => new Date("2026-07-13T12:00:00Z"),
    monthlySeriesLimit: 10,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {},
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 10,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget() {
        return 0;
      },
      async refundBudget() {},
      async saveCursors() {},
    },
    monitoring: {
      async listTimeSeries() {
        monitoringCalls += 1;
        return { timeSeries: [] };
      },
    },
    async forward() {
      return true;
    },
  });
  assert.equal(monitoringCalls, 0);
});

test("a failed Monitoring read refunds its full budget reservation", async () => {
  const refunds: number[] = [];
  let seriesRead = 0;
  const stats = await runGcpMetricsPullOnce({
    now: () => new Date("2026-07-13T12:00:00Z"),
    monthlySeriesLimit: 10,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {},
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 0,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget(_id, reservation) {
        const reserved = Math.min(reservation.requested, reservation.monthlyLimit - seriesRead);
        seriesRead += reserved;
        return reserved;
      },
      async refundBudget(_id, refund) {
        refunds.push(refund.series);
        seriesRead -= refund.series;
      },
      async saveCursors() {},
    },
    monitoring: {
      async listTimeSeries() {
        throw new Error("Monitoring unavailable");
      },
    },
    async forward() {
      throw new Error("failed reads must not be forwarded");
    },
  });

  assert.deepEqual(refunds, [10]);
  assert.equal(seriesRead, 0);
  assert.deepEqual(stats, { connections: 1, seriesRead: 0, pointsForwarded: 0, errors: 1 });
});

test("an empty poll does not checkpoint past delayed Cloud Monitoring samples", async () => {
  const savedCursors: Array<Record<string, Date>> = [];
  await runGcpMetricsPullOnce({
    now: () => new Date("2026-07-13T12:00:00Z"),
    monthlySeriesLimit: 10,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {
              "compute.googleapis.com/instance/cpu/utilization": new Date("2026-07-13T11:55:00Z"),
            },
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 0,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget(_id, reservation) {
        return reservation.requested;
      },
      async refundBudget() {},
      async saveCursors(_id, cursors) {
        savedCursors.push(cursors);
      },
    },
    monitoring: {
      async listTimeSeries() {
        return { timeSeries: [] };
      },
    },
    async forward() {
      throw new Error("empty polls must not be forwarded");
    },
  });

  assert.deepEqual(savedCursors, []);
});

test("overlap reads do not forward metric points at or before the delivered cursor", async () => {
  const forwarded: Array<{
    resourceMetrics: Array<{
      scopeMetrics: Array<{ metrics: Array<{ gauge: { dataPoints: unknown[] } }> }>;
    }>;
  }> = [];
  const starts: Date[] = [];
  const cursor = new Date("2026-07-13T11:45:00Z");
  const stats = await runGcpMetricsPullOnce({
    now: () => new Date("2026-07-13T12:00:00Z"),
    monthlySeriesLimit: 10,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {
              "compute.googleapis.com/instance/cpu/utilization": cursor,
            },
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 0,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget(_id, reservation) {
        return reservation.requested;
      },
      async refundBudget() {},
      async saveCursors() {},
    },
    monitoring: {
      async listTimeSeries(input) {
        starts.push(input.startTime);
        if (starts.length > 1) return { timeSeries: [] };
        return {
          timeSeries: [
            {
              metric: { type: "compute.googleapis.com/instance/cpu/utilization" },
              resource: { type: "gce_instance" },
              metricKind: "GAUGE",
              points: [
                {
                  interval: { endTime: "2026-07-13T11:44:00Z" },
                  value: { doubleValue: 0.4 },
                },
                {
                  interval: { endTime: "2026-07-13T11:49:00Z" },
                  value: { doubleValue: 0.5 },
                },
              ],
            },
          ],
        };
      },
    },
    async forward({ payload }) {
      forwarded.push(payload as (typeof forwarded)[number]);
      return true;
    },
  });

  assert.equal(starts[0]?.toISOString(), "2026-07-13T11:40:00.000Z");
  assert.equal(
    forwarded[0]?.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.gauge.dataPoints.length,
    1,
  );
  assert.equal(stats.pointsForwarded, 1);
});

test("Cloud Run CPU utilization distributions are forwarded as OTLP histograms", async () => {
  const forwarded: unknown[] = [];
  const savedCursors: Array<Record<string, Date>> = [];
  let monitoringCalls = 0;
  const stats = await runGcpMetricsPullOnce({
    now: () => new Date("2026-07-13T12:00:00Z"),
    monthlySeriesLimit: 100,
    store: {
      async listConnected() {
        return [
          {
            id: "connection-id",
            projectId: "project-id",
            gcpProjectId: "acme-production",
            metricsCursors: {},
            metricsBudgetMonth: "2026-07",
            metricsSeriesRead: 0,
            ingestKey: "sl_public_test",
          },
        ];
      },
      async reserveBudget(_id, reservation) {
        return reservation.requested;
      },
      async refundBudget() {},
      async saveCursors(_id, cursors) {
        savedCursors.push(cursors);
      },
    },
    monitoring: {
      async listTimeSeries({ metricType }) {
        monitoringCalls += 1;
        if (metricType !== "run.googleapis.com/container/cpu/utilizations") {
          return { timeSeries: [] };
        }
        return {
          timeSeries: [
            {
              metric: { type: "run.googleapis.com/container/cpu/utilizations" },
              resource: {
                type: "cloud_run_revision",
                labels: { service_name: "checkout-api" },
              },
              metricKind: "DELTA",
              valueType: "DISTRIBUTION",
              points: [
                {
                  interval: {
                    startTime: "2026-07-13T11:48:00Z",
                    endTime: "2026-07-13T11:49:00Z",
                  },
                  value: {
                    distributionValue: {
                      count: "4",
                      mean: 0.5,
                      range: { min: 0.2, max: 0.9 },
                      bucketOptions: {
                        exponentialBuckets: {
                          numFiniteBuckets: 2,
                          growthFactor: 2,
                          scale: 0.25,
                        },
                      },
                      bucketCounts: ["1", "1", "1", "1"],
                    },
                  },
                },
              ],
            },
          ],
        };
      },
    },
    async forward({ payload }) {
      forwarded.push(payload);
      return true;
    },
  });

  const payload = forwarded[0] as {
    resourceMetrics: Array<{
      scopeMetrics: Array<{
        metrics: Array<{
          histogram: {
            aggregationTemporality: number;
            dataPoints: Array<Record<string, unknown>>;
          };
        }>;
      }>;
    }>;
  };
  const histogram = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.histogram;
  assert.equal(histogram?.aggregationTemporality, 1);
  assert.deepEqual(histogram?.dataPoints[0], {
    count: "4",
    sum: 2,
    min: 0.2,
    max: 0.9,
    bucketCounts: ["1", "1", "1", "1"],
    explicitBounds: [0.25, 0.5, 1],
    timeUnixNano: "1783943340000000000",
    startTimeUnixNano: "1783943280000000000",
    attributes: [],
  });
  assert.equal(stats.pointsForwarded, 1);
  assert.equal(
    savedCursors[0]?.["run.googleapis.com/container/cpu/utilizations"]?.toISOString(),
    "2026-07-13T11:49:00.000Z",
  );
});
