import { type DB, schema } from "@superlog/db";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { FiringState } from "./domain.js";

export type AlertRepository = ReturnType<typeof createAlertRepository>;

export type AlertIssueUpsertInput = {
  projectId: string;
  fingerprint: string;
  title: string;
  service: string | null;
  lastSample: schema.IssueSample;
  evaluatedAt: Date;
};

export type AlertIssueUpsertResult = {
  issue: schema.Issue;
  prevIssueId: string | null;
  prevIncidentStatus: string | null;
};

export type FiringRecord = {
  alertId: string;
  groupKey: string;
  state: FiringState;
  observedValue: number;
  evaluatedAt: Date;
  issueId: string | null;
};

export function createAlertRepository(db: DB) {
  return {
    async listDueAlerts(opts: { limit?: number } = {}): Promise<schema.Alert[]> {
      return db
        .select()
        .from(schema.alerts)
        .where(
          and(
            eq(schema.alerts.enabled, true),
            or(
              isNull(schema.alerts.lastEvaluatedAt),
              lt(
                schema.alerts.lastEvaluatedAt,
                sql`now() - (${schema.alerts.evaluationIntervalSeconds} * INTERVAL '1 second')`,
              ),
            ),
          ),
        )
        .limit(opts.limit ?? 100);
    },

    async getLatestFiringState(
      alertId: string,
      groupKey: string,
    ): Promise<FiringState | null> {
      const row = await db.query.alertFirings.findFirst({
        where: and(
          eq(schema.alertFirings.alertId, alertId),
          eq(schema.alertFirings.groupKey, groupKey),
        ),
        orderBy: [desc(schema.alertFirings.evaluatedAt)],
      });
      return row ? row.state : null;
    },

    async upsertAlertIssue(input: AlertIssueUpsertInput): Promise<AlertIssueUpsertResult> {
      const seenAtIso = input.evaluatedAt.toISOString();
      const result = await db.execute<{
        id: string;
        xmax: string;
        prev_issue_id: string | null;
        prev_incident_status: string | null;
      }>(sql`
        WITH prev AS (
          SELECT i.id AS issue_id, inc.status AS incident_status
          FROM issues i
          LEFT JOIN incident_issues ii ON ii.issue_id = i.id
          LEFT JOIN incidents inc ON inc.id = ii.incident_id
          WHERE i.project_id = ${input.projectId}
            AND i.fingerprint = ${input.fingerprint}
            AND i.silenced_at IS NULL
        ),
        up AS (
          INSERT INTO issues (
            project_id, fingerprint, kind, service, exception_type,
            title, message, top_frame, normalized_frames, last_sample,
            first_seen, last_seen, event_count
          ) VALUES (
            ${input.projectId}, ${input.fingerprint}, 'alert', ${input.service}, 'AlertFired',
            ${input.title}, ${input.title}, NULL, '[]'::jsonb, ${JSON.stringify(input.lastSample)}::jsonb,
            ${seenAtIso}::timestamptz, ${seenAtIso}::timestamptz, 1
          )
          ON CONFLICT (project_id, fingerprint) WHERE silenced_at IS NULL DO UPDATE SET
            last_seen = GREATEST(issues.last_seen, EXCLUDED.last_seen),
            event_count = issues.event_count + 1,
            title = EXCLUDED.title,
            message = EXCLUDED.message,
            service = EXCLUDED.service,
            last_sample = EXCLUDED.last_sample
          RETURNING id, xmax
        )
        SELECT
          (SELECT id::text FROM up) AS id,
          (SELECT xmax::text FROM up) AS xmax,
          (SELECT issue_id::text FROM prev) AS prev_issue_id,
          (SELECT incident_status FROM prev) AS prev_incident_status
      `);
      const raw = (
        result as unknown as Array<{
          id: string;
          xmax: string;
          prev_issue_id: string | null;
          prev_incident_status: string | null;
        }>
      )[0];
      const issue = await db.query.issues.findFirst({
        where: eq(schema.issues.id, raw?.id ?? ""),
      });
      if (!issue) throw new Error("failed to load issue after alert upsert");
      return {
        issue,
        prevIssueId: raw?.prev_issue_id ?? null,
        prevIncidentStatus: raw?.prev_incident_status ?? null,
      };
    },

    async recordFiring(record: FiringRecord): Promise<void> {
      await db.insert(schema.alertFirings).values({
        alertId: record.alertId,
        groupKey: record.groupKey,
        state: record.state,
        observedValue: record.observedValue,
        evaluatedAt: record.evaluatedAt,
        issueId: record.issueId,
      });
    },

    async markEvaluated(alertId: string, evaluatedAt: Date): Promise<void> {
      await db
        .update(schema.alerts)
        .set({ lastEvaluatedAt: evaluatedAt })
        .where(eq(schema.alerts.id, alertId));
    },
  };
}
