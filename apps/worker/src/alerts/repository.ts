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

export type EpisodeOpenInput = {
  alertId: string;
  projectId: string;
  groupKey: string;
  startedAt: Date;
  observedValue: number;
  issueId: string | null;
  incidentId: string | null;
};

export type EpisodeTouchInput = {
  alertId: string;
  groupKey: string;
  observedValue: number;
  comparator: schema.AlertComparator;
  evaluatedAt: Date;
};

export type EpisodeCloseInput = {
  alertId: string;
  groupKey: string;
  endedAt: Date;
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

    // Resolve the incident an alert issue is currently linked to (if any), so a
    // freshly-opened episode can point straight at it. `incident_issues` is
    // 1:1 per issue (unique index on issue_id).
    async findIncidentIdForIssue(issueId: string): Promise<string | null> {
      const link = await db.query.incidentIssues.findFirst({
        where: eq(schema.incidentIssues.issueId, issueId),
        columns: { incidentId: true },
      });
      return link?.incidentId ?? null;
    },

    // Open a new episode for an alert+group. `ON CONFLICT` (against the partial
    // unique index over open episodes) makes this idempotent if a previous
    // episode was somehow left open — it folds into that row rather than
    // violating the at-most-one-open invariant.
    async openEpisode(input: EpisodeOpenInput): Promise<void> {
      await db
        .insert(schema.alertEpisodes)
        .values({
          alertId: input.alertId,
          projectId: input.projectId,
          groupKey: input.groupKey,
          state: "firing",
          startedAt: input.startedAt,
          openObservedValue: input.observedValue,
          peakObservedValue: input.observedValue,
          lastObservedValue: input.observedValue,
          lastFiringAt: input.startedAt,
          issueId: input.issueId,
          incidentId: input.incidentId,
        })
        .onConflictDoUpdate({
          target: [schema.alertEpisodes.alertId, schema.alertEpisodes.groupKey],
          targetWhere: sql`state = 'firing'`,
          set: {
            lastObservedValue: input.observedValue,
            lastFiringAt: input.startedAt,
            issueId: input.issueId,
            incidentId: input.incidentId,
            updatedAt: new Date(),
          },
        });
    },

    // Advance an open episode on a still-firing tick: update the latest value,
    // the most-severe value seen so far, and the last-firing timestamp.
    async touchOpenEpisode(input: EpisodeTouchInput): Promise<void> {
      const peakExpr =
        input.comparator === "gt"
          ? sql`GREATEST(${schema.alertEpisodes.peakObservedValue}, ${input.observedValue})`
          : sql`LEAST(${schema.alertEpisodes.peakObservedValue}, ${input.observedValue})`;
      await db
        .update(schema.alertEpisodes)
        .set({
          peakObservedValue: peakExpr,
          lastObservedValue: input.observedValue,
          lastFiringAt: input.evaluatedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.alertEpisodes.alertId, input.alertId),
            eq(schema.alertEpisodes.groupKey, input.groupKey),
            eq(schema.alertEpisodes.state, "firing"),
          ),
        );
    },

    // Close the open episode for an alert+group on recovery.
    async closeOpenEpisode(input: EpisodeCloseInput): Promise<void> {
      await db
        .update(schema.alertEpisodes)
        .set({ state: "resolved", endedAt: input.endedAt, updatedAt: new Date() })
        .where(
          and(
            eq(schema.alertEpisodes.alertId, input.alertId),
            eq(schema.alertEpisodes.groupKey, input.groupKey),
            eq(schema.alertEpisodes.state, "firing"),
          ),
        );
    },

    async markEvaluated(alertId: string, evaluatedAt: Date): Promise<void> {
      await db
        .update(schema.alerts)
        .set({ lastEvaluatedAt: evaluatedAt })
        .where(eq(schema.alerts.id, alertId));
    },
  };
}
