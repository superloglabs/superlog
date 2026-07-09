import type { schema } from "@superlog/db";
import {
  type EvaluationRange,
  type EvaluationResult,
  type FiringState,
  buildAlertIssueSample,
  buildIssueTitle,
  classifyFiringTransition,
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
  handleIssueTransition(issue: schema.Issue, transition: "new"): Promise<void>;
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

// Note: failures anywhere in the episode/issue/incident chain propagate to the
// caller intentionally. Swallowing them would record a firing row and stamp
// `lastEvaluatedAt`, so the alert would never re-attempt the chain on the next
// tick — a firing alert would page nobody. By throwing, the outer per-alert
// handler in `runAlertsTick` logs the failure and skips markEvaluated, so the
// next tick re-evaluates and retries. Every step is idempotent: the episode
// upsert folds into the one open row, the issue upsert is keyed to the episode
// fingerprint, and incident intake re-lands on the existing link.
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
    issueId = await openEpisodeAndNotify(alert, evalResult, evaluatedAt, deps);
  } else if (transition === "still_firing") {
    await deps.repo.touchOpenEpisode({
      alertId: alert.id,
      groupKey: evalResult.groupKey,
      observedValue: evalResult.value,
      comparator: alert.comparator,
      evaluatedAt,
      lastSample: buildAlertIssueSample(alert, evalResult.value, evalResult.groupKey, evaluatedAt),
    });
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
    await deps.repo.closeOpenEpisode({
      alertId: alert.id,
      groupKey: evalResult.groupKey,
      endedAt: evaluatedAt,
    });
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

// The breach (episode) is the trigger entity: open it first — the partial
// unique index over open rows makes that the dedup arbiter — then raise its
// 1:1 issue and hand it to incident intake. Finally point the episode at the
// incident the issue landed on.
async function openEpisodeAndNotify(
  alert: schema.Alert,
  evalResult: EvaluationResult,
  evaluatedAt: Date,
  deps: EvaluateAlertDeps,
): Promise<string> {
  const { episodeId } = await deps.repo.openOrContinueEpisode({
    alertId: alert.id,
    projectId: alert.projectId,
    groupKey: evalResult.groupKey,
    startedAt: evaluatedAt,
    observedValue: evalResult.value,
    comparator: alert.comparator,
    evaluationIntervalSeconds: alert.evaluationIntervalSeconds,
  });
  const upsert = await deps.repo.upsertEpisodeIssue({
    episodeId,
    projectId: alert.projectId,
    title: buildIssueTitle(alert, evalResult.value, evalResult.groupKey),
    service: serviceFromGroup(alert.groupBy, evalResult.groupKey),
    lastSample: buildAlertIssueSample(alert, evalResult.value, evalResult.groupKey, evaluatedAt),
    evaluatedAt,
  });
  // Always notify, even when the upsert folded into an existing row: a retried
  // tick whose previous attempt died before intake must not skip it. Racing
  // duplicates on the same issue are serialized inside incident intake (a
  // per-issue advisory lock around the read-then-create section — see
  // incident-intake.ts), so both racers land on one incident.
  await deps.handleIssueTransition(upsert.issue, "new");
  const incidentId = await deps.repo.findIncidentIdForIssue(upsert.issue.id);
  if (incidentId) {
    await deps.repo.setEpisodeIncident(episodeId, incidentId);
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
