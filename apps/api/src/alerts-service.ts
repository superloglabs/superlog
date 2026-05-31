import type { ClickHouseClient } from "@clickhouse/client";
import { db, schema } from "@superlog/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { logger } from "./logger.js";
import { type ResourceAttrFilter, countSeries, metricSeries, pickStep } from "./mcp/clickhouse.js";

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
