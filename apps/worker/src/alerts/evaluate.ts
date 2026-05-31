import type { schema } from "@superlog/db";
import {
  alertFingerprint,
  buildAlertIssueSample,
  buildIssueTitle,
  classifyFiringTransition,
  classifyIssueTransition,
  deriveEvaluations,
  evaluationRange,
  type EvaluationRange,
  type EvaluationResult,
  type FiringState,
  type IssueTransition,
  serviceFromGroup,
} from "./domain.js";
import type { AlertRepository } from "./repository.js";

export type AlertLogger = {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
};

export type EvaluateAlertDeps = {
  repo: AlertRepository;
  aggregate(alert: schema.Alert, range: EvaluationRange): Promise<Map<string, number>>;
  handleIssueTransition(
    issue: schema.Issue,
    transition: "new" | "regressed",
  ): Promise<void>;
  logger: AlertLogger;
  now(): Date;
};

export async function evaluateAlertWorkflow(
  alert: schema.Alert,
  deps: EvaluateAlertDeps,
): Promise<void> {
  const now = deps.now();
  const range = evaluationRange(now, alert.windowMinutes);
  const groups = await deps.aggregate(alert, range);
  const evaluations = deriveEvaluations(alert, groups);

  for (const evalResult of evaluations) {
    await processEvaluation(alert, evalResult, now, deps);
  }

  await deps.repo.markEvaluated(alert.id, now);
}

async function processEvaluation(
  alert: schema.Alert,
  evalResult: EvaluationResult,
  evaluatedAt: Date,
  deps: EvaluateAlertDeps,
): Promise<void> {
  const prevState = await deps.repo.getLatestFiringState(alert.id, evalResult.groupKey);
  const transition = classifyFiringTransition(prevState, evalResult.firing);
  const state: FiringState = evalResult.firing ? "firing" : "ok";

  let issueId: string | null = null;

  if (transition === "new_firing") {
    deps.logger.warn(
      {
        alert_id: alert.id,
        alert_name: alert.name,
        project_id: alert.projectId,
        group_key: evalResult.groupKey,
        observed_value: evalResult.value,
        threshold: alert.threshold,
        comparator: alert.comparator,
        source: alert.source,
        transition: prevState === "ok" ? "ok→firing" : "→firing",
      },
      "alert firing",
    );
    issueId = await upsertAndNotify(alert, evalResult, evaluatedAt, deps);
  } else if (transition === "recovered") {
    deps.logger.info(
      {
        alert_id: alert.id,
        alert_name: alert.name,
        project_id: alert.projectId,
        group_key: evalResult.groupKey,
        observed_value: evalResult.value,
        threshold: alert.threshold,
      },
      "alert recovered",
    );
  }

  await deps.repo.recordFiring({
    alertId: alert.id,
    groupKey: evalResult.groupKey,
    state,
    observedValue: evalResult.value,
    evaluatedAt,
    issueId,
  });
}

// Note: failures here propagate to the caller intentionally. Swallowing
// them would record a firing row with `issueId = null` and stamp
// `lastEvaluatedAt`, so the alert would never re-attempt the upsert on
// the next tick — a firing alert would page nobody. By throwing, the
// outer per-alert handler in `runAlertsTick` logs the failure and skips
// markEvaluated, so the next tick re-evaluates and retries.
async function upsertAndNotify(
  alert: schema.Alert,
  evalResult: EvaluationResult,
  evaluatedAt: Date,
  deps: EvaluateAlertDeps,
): Promise<string> {
  const fingerprint = alertFingerprint(alert.id, evalResult.groupKey);
  const title = buildIssueTitle(alert, evalResult.value, evalResult.groupKey);
  const service = serviceFromGroup(alert.groupBy, evalResult.groupKey);
  const lastSample = buildAlertIssueSample(
    alert,
    evalResult.value,
    evalResult.groupKey,
    evaluatedAt,
  );
  const upsert = await deps.repo.upsertAlertIssue({
    projectId: alert.projectId,
    fingerprint,
    title,
    service,
    lastSample,
    evaluatedAt,
  });
  const issueTransition: IssueTransition = classifyIssueTransition(
    upsert.prevIssueId,
    upsert.prevIncidentStatus,
  );
  if (issueTransition === "new" || issueTransition === "regressed") {
    await deps.handleIssueTransition(upsert.issue, issueTransition);
  }
  return upsert.issue.id;
}

export type RunAlertsTickDeps = EvaluateAlertDeps & {
  listDueAlerts(): Promise<schema.Alert[]>;
};

export async function runAlertsTick(deps: RunAlertsTickDeps): Promise<number> {
  const due = await deps.listDueAlerts();
  if (due.length > 0) {
    deps.logger.info({ alert_count: due.length }, "evaluation tick");
  }

  let processed = 0;
  for (const alert of due) {
    const started = Date.now();
    try {
      await evaluateAlertWorkflow(alert, deps);
      processed += 1;
    } catch (err) {
      deps.logger.error(
        {
          err,
          alert_id: alert.id,
          alert_name: alert.name,
          project_id: alert.projectId,
          duration_ms: Date.now() - started,
        },
        "alert evaluation failed",
      );
    }
  }
  return processed;
}
