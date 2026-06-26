import type { ClickHouseClient } from "@clickhouse/client";
import { db, schema } from "@superlog/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { logger } from "./logger.js";
import {
  type MetricAggregation,
  type ResourceAttrFilter,
  countSeries,
  metricSeries,
  pickStep,
} from "./mcp/clickhouse.js";

const log = logger.child({ scope: "alerts" });

export const alertSourceSchema = z.enum(["logs", "traces", "metric"]);
export const alertAggregationSchema = z.enum(["count", "sum", "avg"]);
export const alertComparatorSchema = z.enum(["gt", "lt"]);
export const alertGroupModeSchema = z.enum(["per_group", "single"]);

const resourceAttrSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(500),
});

export const alertFilterSchema = z.object({
  resourceAttrs: z.array(resourceAttrSchema).max(50).optional(),
  service: z.string().max(200).optional(),
  severity: z.string().max(50).optional(),
  spanName: z.string().max(200).optional(),
  statusCode: z.string().max(50).optional(),
  minDurationMs: z.number().nonnegative().optional(),
});

export const alertInputSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  source: alertSourceSchema,
  metricName: z.string().max(200).nullable().optional(),
  filter: alertFilterSchema.optional(),
  groupBy: z.string().max(200).nullable().optional(),
  groupMode: alertGroupModeSchema.optional(),
  aggregation: alertAggregationSchema,
  comparator: alertComparatorSchema,
  threshold: z.number().finite(),
  windowMinutes: z.number().int().min(1).max(1440).optional(),
  evaluationIntervalSeconds: z.number().int().min(15).max(3600).optional(),
});

export type AlertInput = z.infer<typeof alertInputSchema>;

export function validateAlertInput(input: AlertInput): void {
  if (input.source === "metric" && !input.metricName) {
    throw new HTTPException(400, { message: "metricName required when source = metric" });
  }
  if (input.source !== "metric" && input.aggregation !== "count") {
    throw new HTTPException(400, {
      message: "aggregation must be 'count' for logs/traces sources",
    });
  }
  if (input.source === "metric" && input.aggregation === "count") {
    throw new HTTPException(400, {
      message: "aggregation must be 'sum' or 'avg' for metric source",
    });
  }
  if (input.groupMode === "per_group" && !input.groupBy) {
    throw new HTTPException(400, { message: "groupBy required when groupMode = per_group" });
  }
}

export function alertInputToFilter(input: AlertInput): schema.AlertFilter {
  return {
    resourceAttrs: input.filter?.resourceAttrs,
    service: input.filter?.service,
    severity: input.filter?.severity,
    spanName: input.filter?.spanName,
    statusCode: input.filter?.statusCode,
    minDurationMs: input.filter?.minDurationMs,
  };
}

function rangeForWindow(windowMinutes: number): { since: string; until: string } {
  const now = new Date();
  const since = new Date(now.getTime() - windowMinutes * 60_000);
  return { since: since.toISOString(), until: now.toISOString() };
}

function compare(value: number, comparator: schema.AlertComparator, threshold: number): boolean {
  if (comparator === "gt") return value > threshold;
  return value < threshold;
}

export async function evaluateAlertQuery(
  ch: ClickHouseClient,
  alert: {
    projectId: string;
    source: schema.AlertSource;
    metricName: string | null;
    filter: schema.AlertFilter;
    groupBy: string | null;
    groupMode: schema.AlertGroupMode;
    aggregation: schema.AlertAggregation;
    windowMinutes: number;
  },
): Promise<{ groups: Map<string, number>; total: number }> {
  const range = rangeForWindow(alert.windowMinutes);
  const rangeSeconds = alert.windowMinutes * 60;
  const step = pickStep(rangeSeconds);
  const resourceAttrs: ResourceAttrFilter[] | undefined = alert.filter.resourceAttrs;
  const groupBy = alert.groupBy || undefined;

  const groupSums = new Map<string, number>();
  const groupCounts = new Map<string, number>();

  if (alert.source === "metric") {
    if (!alert.metricName) return { groups: new Map(), total: 0 };
    const rows = await metricSeries(
      ch,
      alert.projectId,
      alert.metricName,
      {
        range,
        service: alert.filter.service,
        resourceAttrs,
      },
      groupBy,
      step,
    );
    for (const row of rows) {
      const key = row.group ?? "";
      groupSums.set(key, (groupSums.get(key) ?? 0) + row.value);
      groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    }
  } else {
    const rows = await countSeries(
      ch,
      alert.projectId,
      alert.source,
      {
        range,
        service: alert.filter.service,
        resourceAttrs,
        severity: alert.filter.severity,
        spanName: alert.filter.spanName,
        statusCode: alert.filter.statusCode,
        minDurationMs: alert.filter.minDurationMs,
      },
      groupBy,
      step,
    );
    for (const row of rows) {
      const key = row.group ?? "";
      groupSums.set(key, (groupSums.get(key) ?? 0) + row.count);
      groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    }
  }

  const groups = new Map<string, number>();
  for (const [key, sum] of groupSums) {
    if (alert.aggregation === "avg") {
      const n = groupCounts.get(key) ?? 1;
      groups.set(key, n > 0 ? sum / n : 0);
    } else {
      groups.set(key, sum);
    }
  }

  let total = 0;
  if (alert.aggregation === "avg") {
    let sumAll = 0;
    let nAll = 0;
    for (const [key, sum] of groupSums) {
      sumAll += sum;
      nAll += groupCounts.get(key) ?? 0;
    }
    total = nAll > 0 ? sumAll / nAll : 0;
  } else {
    for (const value of groupSums.values()) total += value;
  }

  return { groups, total };
}

export type AlertEvalResult =
  | { mode: "single"; value: number; breaches: number }
  | {
      mode: "per_group";
      groups: { key: string; value: number; breaching: boolean }[];
      breaches: number;
    };

export function summarizeEvaluation(
  alert: {
    comparator: schema.AlertComparator;
    threshold: number;
    groupMode: schema.AlertGroupMode;
    groupBy: string | null;
  },
  evaluation: { groups: Map<string, number>; total: number },
): AlertEvalResult {
  if (alert.groupMode === "per_group" && alert.groupBy) {
    const rows: { key: string; value: number; breaching: boolean }[] = [];
    for (const [key, value] of evaluation.groups) {
      rows.push({
        key,
        value,
        breaching: compare(value, alert.comparator, alert.threshold),
      });
    }
    rows.sort((a, b) => b.value - a.value);
    return {
      mode: "per_group",
      groups: rows,
      breaches: rows.filter((g) => g.breaching).length,
    };
  }
  return {
    mode: "single",
    value: evaluation.total,
    breaches: compare(evaluation.total, alert.comparator, alert.threshold) ? 1 : 0,
  };
}

export async function listAlertsForProject(projectId: string): Promise<schema.Alert[]> {
  return db.query.alerts.findMany({
    where: eq(schema.alerts.projectId, projectId),
    orderBy: [asc(schema.alerts.name)],
  });
}

export async function getAlertWithFirings(
  projectId: string,
  id: string,
): Promise<(schema.Alert & { firings: schema.AlertFiring[] }) | null> {
  const alert = await db.query.alerts.findFirst({
    where: and(eq(schema.alerts.id, id), eq(schema.alerts.projectId, projectId)),
  });
  if (!alert) return null;
  const firings = await db.query.alertFirings.findMany({
    where: eq(schema.alertFirings.alertId, id),
    orderBy: [desc(schema.alertFirings.evaluatedAt)],
    limit: 50,
  });
  return { ...alert, firings };
}

export async function createAlertRecord(
  projectId: string,
  userId: string,
  input: AlertInput,
): Promise<schema.Alert> {
  validateAlertInput(input);
  const inserted = await db
    .insert(schema.alerts)
    .values({
      projectId,
      name: input.name,
      enabled: input.enabled ?? true,
      source: input.source,
      metricName: input.metricName ?? null,
      filter: alertInputToFilter(input),
      groupBy: input.groupBy ?? null,
      groupMode: input.groupMode ?? "single",
      aggregation: input.aggregation,
      comparator: input.comparator,
      threshold: input.threshold,
      windowMinutes: input.windowMinutes ?? 5,
      evaluationIntervalSeconds: input.evaluationIntervalSeconds ?? 60,
      createdBy: userId,
    })
    .returning();
  log.info(
    {
      alert_id: inserted[0]?.id,
      project_id: projectId,
      actor_user_id: userId,
      source: input.source,
      comparator: input.comparator,
      threshold: input.threshold,
      window_minutes: input.windowMinutes ?? 5,
    },
    "alert created",
  );
  const row = inserted[0];
  if (!row) throw new Error("alerts insert returned no rows");
  return row;
}

export async function updateAlertRecord(
  projectId: string,
  id: string,
  patch: Partial<AlertInput>,
): Promise<schema.Alert | null> {
  const existing = await db.query.alerts.findFirst({
    where: and(eq(schema.alerts.id, id), eq(schema.alerts.projectId, projectId)),
  });
  if (!existing) return null;

  const merged: AlertInput = {
    name: patch.name ?? existing.name,
    enabled: patch.enabled ?? existing.enabled,
    source: patch.source ?? existing.source,
    metricName: patch.metricName !== undefined ? patch.metricName : existing.metricName,
    filter: patch.filter ?? existing.filter,
    groupBy: patch.groupBy !== undefined ? patch.groupBy : existing.groupBy,
    groupMode: patch.groupMode ?? existing.groupMode,
    aggregation: patch.aggregation ?? existing.aggregation,
    comparator: patch.comparator ?? existing.comparator,
    threshold: patch.threshold ?? existing.threshold,
    windowMinutes: patch.windowMinutes ?? existing.windowMinutes,
    evaluationIntervalSeconds:
      patch.evaluationIntervalSeconds ?? existing.evaluationIntervalSeconds,
  };
  validateAlertInput(merged);

  const updated = await db
    .update(schema.alerts)
    .set({
      name: merged.name,
      enabled: merged.enabled ?? existing.enabled,
      source: merged.source,
      metricName: merged.metricName ?? null,
      filter: alertInputToFilter(merged),
      groupBy: merged.groupBy ?? null,
      groupMode: merged.groupMode ?? "single",
      aggregation: merged.aggregation,
      comparator: merged.comparator,
      threshold: merged.threshold,
      windowMinutes: merged.windowMinutes ?? 5,
      evaluationIntervalSeconds: merged.evaluationIntervalSeconds ?? 60,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.alerts.id, id), eq(schema.alerts.projectId, projectId)))
    .returning();
  return updated[0] ?? null;
}

export async function deleteAlertRecord(
  projectId: string,
  id: string,
  actorUserId: string,
): Promise<void> {
  await db
    .delete(schema.alerts)
    .where(and(eq(schema.alerts.id, id), eq(schema.alerts.projectId, projectId)));
  log.info({ alert_id: id, project_id: projectId, actor_user_id: actorUserId }, "alert deleted");
}

export async function previewAlert(
  ch: ClickHouseClient,
  projectId: string,
  input: AlertInput,
): Promise<AlertEvalResult> {
  validateAlertInput(input);
  const evaluation = await evaluateAlertQuery(ch, {
    projectId,
    source: input.source,
    metricName: input.metricName ?? null,
    filter: alertInputToFilter(input),
    groupBy: input.groupBy ?? null,
    groupMode: input.groupMode ?? "single",
    aggregation: input.aggregation,
    windowMinutes: input.windowMinutes ?? 5,
  });
  return summarizeEvaluation(
    {
      comparator: input.comparator,
      threshold: input.threshold,
      groupMode: input.groupMode ?? "single",
      groupBy: input.groupBy ?? null,
    },
    evaluation,
  );
}

export type AlertEpisodeIncidentSummary = {
  id: string;
  codename: string;
  status: string;
  severity: string | null;
};

export type AlertEpisodeView = {
  id: string;
  alertId: string;
  groupKey: string;
  state: "firing" | "resolved";
  startedAt: string;
  endedAt: string | null;
  openObservedValue: number;
  peakObservedValue: number;
  lastObservedValue: number;
  lastFiringAt: string;
  // 1-based ordinal within the alert ("Episode #N"), oldest = 1.
  seq: number;
  incident: AlertEpisodeIncidentSummary | null;
};

// List an alert's episodes, newest-first, each carrying a stable 1-based
// ordinal and a summary of the incident it produced (if any). Returns null when
// the alert doesn't belong to the project (404 at the route layer).
// One bucket of the evaluated signal, in the same shape the dashboard widgets'
// CountChart consumes (`{ bucket, group, value }` with a raw ClickHouse bucket
// string), so the alert preview reuses the same chart component.
export type AlertSeriesRow = { bucket: string; group: string; value: number };

export type AlertPreviewSeries = {
  rows: AlertSeriesRow[];
  // Server bucket step ("5 MINUTE") — drives CountChart's x-axis grid.
  step: string;
  range: { since: string; until: string };
  threshold: number;
  comparator: schema.AlertComparator;
  windowMinutes: number;
  // Human label for the plotted signal (metric name, or "<source> count").
  label: string;
};

// The time series the alert evaluates, bucketed at the alert's own window so
// each point is exactly one evaluation ("count over the window" / "metric agg
// over the window"). Used by the preview graph to show the signal against the
// threshold line over the recent past. Collapses groups to a single overview
// series (groupBy is ignored here — per-group preview would need a series each).
const PREVIEW_BUCKETS = 24;

export async function previewAlertSeries(
  ch: ClickHouseClient,
  projectId: string,
  input: AlertInput,
): Promise<AlertPreviewSeries> {
  validateAlertInput(input);
  const windowMinutes = input.windowMinutes ?? 5;
  const now = Date.now();
  const since = new Date(now - windowMinutes * PREVIEW_BUCKETS * 60_000).toISOString();
  const range = { since, until: new Date(now).toISOString() };
  const step = { n: windowMinutes, unit: "MINUTE" as const };
  const filter = alertInputToFilter(input);
  const label = input.source === "metric" ? (input.metricName ?? "metric") : `${input.source} count`;

  const byBucket = new Map<string, number>();
  if (input.source === "metric") {
    if (input.metricName) {
      const rows = await metricSeries(
        ch,
        projectId,
        input.metricName,
        { range, service: filter.service, resourceAttrs: filter.resourceAttrs },
        undefined,
        step,
        input.aggregation as MetricAggregation,
      );
      for (const r of rows) byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + r.value);
    }
  } else {
    const rows = await countSeries(
      ch,
      projectId,
      input.source,
      {
        range,
        service: filter.service,
        resourceAttrs: filter.resourceAttrs,
        severity: filter.severity,
        spanName: filter.spanName,
        statusCode: filter.statusCode,
        minDurationMs: filter.minDurationMs,
      },
      undefined,
      step,
    );
    for (const r of rows) byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + r.count);
  }

  const rows: AlertSeriesRow[] = [...byBucket.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, value]) => ({ bucket, group: label, value }));

  return {
    rows,
    step: `${step.n} ${step.unit}`,
    range,
    threshold: input.threshold,
    comparator: input.comparator,
    windowMinutes,
    label,
  };
}

export async function listAlertEpisodes(
  projectId: string,
  alertId: string,
): Promise<AlertEpisodeView[] | null> {
  const alert = await db.query.alerts.findFirst({
    where: and(eq(schema.alerts.id, alertId), eq(schema.alerts.projectId, projectId)),
    columns: { id: true },
  });
  if (!alert) return null;

  // Fetch oldest-first so the ordinal is stable regardless of how many we show.
  const rows = await db.query.alertEpisodes.findMany({
    where: eq(schema.alertEpisodes.alertId, alertId),
    orderBy: [asc(schema.alertEpisodes.startedAt)],
  });
  if (rows.length === 0) return [];

  const incidentIds = [
    ...new Set(rows.map((r) => r.incidentId).filter((id): id is string => id !== null)),
  ];
  const incidents = incidentIds.length
    ? await db.query.incidents.findMany({
        where: inArray(schema.incidents.id, incidentIds),
        columns: { id: true, codename: true, status: true, severity: true },
      })
    : [];
  const incMap = new Map(incidents.map((i) => [i.id, i]));

  const views = rows.map((r, i): AlertEpisodeView => {
    const inc = r.incidentId ? incMap.get(r.incidentId) : undefined;
    return {
      id: r.id,
      alertId: r.alertId,
      groupKey: r.groupKey,
      state: r.state,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      openObservedValue: r.openObservedValue,
      peakObservedValue: r.peakObservedValue,
      lastObservedValue: r.lastObservedValue,
      lastFiringAt: r.lastFiringAt.toISOString(),
      seq: i + 1,
      incident: inc
        ? { id: inc.id, codename: inc.codename, status: inc.status, severity: inc.severity }
        : null,
    };
  });
  return views.reverse();
}

export type IncidentAlertEpisodeView = {
  id: string;
  alertId: string;
  alertName: string;
  groupKey: string;
  state: "firing" | "resolved";
  startedAt: string;
  endedAt: string | null;
  peakObservedValue: number;
  seq: number;
};

// The alert episodes that triggered a given incident, for the incident detail
// "Triggered by" back-link. Computes each episode's per-alert ordinal so the UI
// can render "alert X · Episode #N".
export async function loadIncidentAlertEpisodes(
  incidentId: string,
): Promise<IncidentAlertEpisodeView[]> {
  const linked = await db.query.alertEpisodes.findMany({
    where: eq(schema.alertEpisodes.incidentId, incidentId),
    orderBy: [desc(schema.alertEpisodes.startedAt)],
  });
  if (linked.length === 0) return [];

  const alertIds = [...new Set(linked.map((r) => r.alertId))];
  const alertRows = await db.query.alerts.findMany({
    where: inArray(schema.alerts.id, alertIds),
    columns: { id: true, name: true },
  });
  const nameMap = new Map(alertRows.map((a) => [a.id, a.name]));

  // Build the per-alert ordinal map from all episodes of the involved alerts.
  const allForAlerts = await db.query.alertEpisodes.findMany({
    where: inArray(schema.alertEpisodes.alertId, alertIds),
    columns: { id: true, alertId: true, startedAt: true },
    orderBy: [asc(schema.alertEpisodes.startedAt)],
  });
  const seqMap = new Map<string, number>();
  const counters = new Map<string, number>();
  for (const e of allForAlerts) {
    const n = (counters.get(e.alertId) ?? 0) + 1;
    counters.set(e.alertId, n);
    seqMap.set(e.id, n);
  }

  return linked.map((r) => ({
    id: r.id,
    alertId: r.alertId,
    alertName: nameMap.get(r.alertId) ?? "alert",
    groupKey: r.groupKey,
    state: r.state,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    peakObservedValue: r.peakObservedValue,
    seq: seqMap.get(r.id) ?? 1,
  }));
}

export async function testAlertById(
  ch: ClickHouseClient,
  projectId: string,
  id: string,
): Promise<AlertEvalResult | null> {
  const alert = await db.query.alerts.findFirst({
    where: and(eq(schema.alerts.id, id), eq(schema.alerts.projectId, projectId)),
  });
  if (!alert) return null;
  const evaluation = await evaluateAlertQuery(ch, {
    projectId: alert.projectId,
    source: alert.source,
    metricName: alert.metricName,
    filter: alert.filter,
    groupBy: alert.groupBy,
    groupMode: alert.groupMode,
    aggregation: alert.aggregation,
    windowMinutes: alert.windowMinutes,
  });
  return summarizeEvaluation(alert, evaluation);
}
