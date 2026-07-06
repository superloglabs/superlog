import type { schema } from "@superlog/db";
import {
  type EvaluationRange,
  type EvaluationResult,
  type FiringState,
  type IssueTransition,
  alertFingerprint,
  buildAlertIssueSample,
  buildIssueTitle,
  classifyFiringTransition,
  classifyIssueTransition,
  deriveEvaluations,
  evaluationRange,
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
  handleIssueTransition(issue: schema.Issue, transition: "new" | "recurred"): Promise<void>;
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
    await openEpisodeBestEffort(alert, evalResult, evaluatedAt, issueId, deps);
  } else if (transition === "still_firing") {
    await runEpisodeBestEffort(alert, evalResult.groupKey, deps, () =>
      deps.repo.touchOpenEpisode({
        alertId: alert.id,
        groupKey: evalResult.groupKey,
        observedValue: evalResult.value,
        comparator: alert.comparator,
        evaluatedAt,
      }),
    );
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
    await runEpisodeBestEffort(alert, evalResult.groupKey, deps, () =>
      deps.repo.closeOpenEpisode({
        alertId: alert.id,
        groupKey: evalResult.groupKey,
        endedAt: evaluatedAt,
      }),
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

// Episodes are a secondary, read-side record of a contiguous activation. They
// must never break the paging-critical issue/incident path or the
// recordFiring/markEvaluated invariant, so every episode write is best-effort:
// a failure is logged and swallowed rather than propagated.
async function runEpisodeBestEffort(
  alert: schema.Alert,
  groupKey: string,
  deps: EvaluateAlertDeps,
  op: () => Promise<void>,
): Promise<void> {
  try {
    await op();
  } catch (err) {
    deps.logger.error(
      { err, alert_id: alert.id, project_id: alert.projectId, group_key: groupKey },
      "alert episode update failed",
    );
  }
}

// Open a fresh episode for a new firing, pointing it at the issue just raised
// and the incident that issue resolves to (created/linked synchronously inside
// upsertAndNotify before we get here).
async function openEpisodeBestEffort(
  alert: schema.Alert,
  evalResult: EvaluationResult,
  evaluatedAt: Date,
  issueId: string,
  deps: EvaluateAlertDeps,
): Promise<void> {
  await runEpisodeBestEffort(alert, evalResult.groupKey, deps, async () => {
    const incidentId = await deps.repo.findIncidentIdForIssue(issueId);
    await deps.repo.openEpisode({
      alertId: alert.id,
      projectId: alert.projectId,
      groupKey: evalResult.groupKey,
      startedAt: evaluatedAt,
      observedValue: evalResult.value,
      comparator: alert.comparator,
      evaluationIntervalSeconds: alert.evaluationIntervalSeconds,
      issueId,
      incidentId,
    });
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
    upsert.prevIssueStatus,
    upsert.inserted,
  );
  if (issueTransition === "new" || issueTransition === "recurred") {
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
