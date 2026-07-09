import type { ClickHouseClient } from "@clickhouse/client";
import { db, type schema } from "@superlog/db";
import { runAlertsTick } from "./alerts/evaluate.js";
import { createAlertMetricsRepository } from "./alerts/metrics-repository.js";
import { createAlertRepository } from "./alerts/repository.js";
import { logger } from "./logger.js";

const log = logger.child({ scope: "alerts" });

export async function tickAlerts(
  ch: ClickHouseClient,
  // Every episode is a fresh issue, so the only transition an alert can raise
  // is "new" — recurrence chaining is decided inside incident intake.
  handleIssueTransition: (issue: schema.Issue, transition: "new") => Promise<void>,
): Promise<number> {
  const repo = createAlertRepository(db);
  const metrics = createAlertMetricsRepository(ch);
  return runAlertsTick({
    repo,
    aggregate: metrics.aggregate,
    handleIssueTransition,
    logger: log,
    now: () => new Date(),
    listDueAlerts: () => repo.listDueAlerts(),
  });
}
