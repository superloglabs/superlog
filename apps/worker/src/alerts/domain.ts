import type { schema } from "@superlog/db";

export type FiringState = "firing" | "ok";

export type EvaluationResult = {
  groupKey: string;
  value: number;
  firing: boolean;
};

export type FiringTransition = "new_firing" | "recovered" | "still_firing" | "still_ok";

export type IssueTransition = "new" | "recurred" | "suppressed" | "seen";

export function compare(
  value: number,
  comparator: schema.AlertComparator,
  threshold: number,
): boolean {
  return comparator === "gt" ? value > threshold : value < threshold;
}

// The "worst" of two observed values for an alert's comparator direction:
// `gt` alerts breach harder as the value climbs (keep the max), `lt` alerts
// breach harder as it drops (keep the min). Used to track an episode's peak.
export function moreSevereValue(
  prev: number,
  next: number,
  comparator: schema.AlertComparator,
): number {
  return comparator === "gt" ? Math.max(prev, next) : Math.min(prev, next);
}

export function alertFingerprint(alertId: string, groupKey: string): string {
  return groupKey ? `alert:${alertId}:${groupKey}` : `alert:${alertId}`;
}

export function serviceFromGroup(groupBy: string | null, groupKey: string): string | null {
  if (groupBy !== "service.name" && groupBy !== "service") return null;
  return groupKey || null;
}

export function buildIssueTitle(
  alert: Pick<schema.Alert, "name" | "comparator" | "threshold">,
  value: number,
  groupKey: string,
): string {
  const op = alert.comparator === "gt" ? ">" : "<";
  const observed = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
  const suffix = groupKey ? ` group=${groupKey}` : "";
  return `${alert.name} ${op} ${alert.threshold} (observed=${observed})${suffix}`;
}

// Given the raw per-group aggregations from ClickHouse, produce one
// `EvaluationResult` per intended firing decision. `per_group` mode emits one
// result per group key; otherwise we collapse to a single result whose value
// is either the sum or the across-group average.
export function deriveEvaluations(
  alert: Pick<schema.Alert, "groupMode" | "groupBy" | "aggregation" | "comparator" | "threshold">,
  groups: ReadonlyMap<string, number>,
): EvaluationResult[] {
  if (alert.groupMode === "per_group" && alert.groupBy) {
    const out: EvaluationResult[] = [];
    for (const [groupKey, value] of groups) {
      out.push({
        groupKey,
        value,
        firing: compare(value, alert.comparator, alert.threshold),
      });
    }
    return out;
  }

  let total = 0;
  if (alert.aggregation === "avg" && groups.size > 0) {
    let sum = 0;
    for (const v of groups.values()) sum += v;
    total = sum / groups.size;
  } else {
    for (const v of groups.values()) total += v;
  }
  return [
    {
      groupKey: "",
      value: total,
      firing: compare(total, alert.comparator, alert.threshold),
    },
  ];
}

export function classifyFiringTransition(
  prevState: FiringState | null,
  currentFiring: boolean,
): FiringTransition {
  if (currentFiring) {
    return prevState === "firing" ? "still_firing" : "new_firing";
  }
  return prevState === "firing" ? "recovered" : "still_ok";
}

export function classifyIssueTransition(
  prevIssueId: string | null,
  prevIssueStatus: string | null,
  inserted = false,
): IssueTransition {
  // A genuinely inserted row is always new — see telemetry/ingest.ts for the
  // pre-0082 migration-window case where `prev` can show a stale silenced row.
  if (inserted || prevIssueId === null) return "new";
  if (prevIssueStatus === "silenced" || prevIssueStatus === "under_observation") {
    return "suppressed";
  }
  if (prevIssueStatus === "resolved") return "recurred";
  return "seen";
}

export function buildAlertIssueSample(
  alert: Pick<schema.Alert, "name" | "comparator" | "threshold" | "groupBy">,
  value: number,
  groupKey: string,
  evaluatedAt: Date,
): schema.IssueSample {
  return {
    kind: "log",
    service: serviceFromGroup(alert.groupBy, groupKey),
    severity: null,
    message: buildIssueTitle(alert, value, groupKey),
    body: null,
    exceptionType: "AlertFired",
    topFrame: null,
    normalizedFrames: [],
    stacktrace: null,
    seenAt: evaluatedAt.toISOString(),
  };
}

export type EvaluationRange = { since: string; until: string };

export function evaluationRange(now: Date, windowMinutes: number): EvaluationRange {
  const sinceMs = now.getTime() - windowMinutes * 60_000;
  return {
    since: new Date(sinceMs).toISOString(),
    until: now.toISOString(),
  };
}
