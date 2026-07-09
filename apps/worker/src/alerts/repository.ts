import { type DB, schema } from "@superlog/db";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { type FiringState, alertEpisodeFingerprint } from "./domain.js";

export type AlertRepository = ReturnType<typeof createAlertRepository>;

export type EpisodeIssueUpsertInput = {
  episodeId: string;
  projectId: string;
  title: string;
  service: string | null;
  lastSample: schema.IssueSample;
  evaluatedAt: Date;
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
  comparator: schema.AlertComparator;
  // Used to tell a missed-close stale open (recovery left a multi-interval gap)
  // apart from a concurrent duplicate new_firing (no gap).
  evaluationIntervalSeconds: number;
};

export type EpisodeTouchInput = {
  alertId: string;
  groupKey: string;
  observedValue: number;
  comparator: schema.AlertComparator;
  evaluatedAt: Date;
  lastSample: schema.IssueSample;
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

    async getLatestFiringState(alertId: string, groupKey: string): Promise<FiringState | null> {
      const row = await db.query.alertFirings.findFirst({
        where: and(
          eq(schema.alertFirings.alertId, alertId),
          eq(schema.alertFirings.groupKey, groupKey),
        ),
        orderBy: [desc(schema.alertFirings.evaluatedAt)],
      });
      return row ? row.state : null;
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
    // freshly-opened episode can point straight at it. An issue keeps one link
    // per incident it has driven; the newest link is its current incident.
    async findIncidentIdForIssue(issueId: string): Promise<string | null> {
      const link = await db.query.incidentIssues.findFirst({
        where: eq(schema.incidentIssues.issueId, issueId),
        orderBy: [desc(schema.incidentIssues.createdAt)],
        columns: { incidentId: true },
      });
      return link?.incidentId ?? null;
    },

    // Open (or continue) the episode for an alert+group. The partial-unique
    // index over open rows is the dedup arbiter: there is never more than one
    // open row per (alert, group), so a single activation can't fragment into
    // multiple episodes even under concurrent worker tasks all classifying the
    // same `new_firing` — the extras fold into the one open row.
    //
    // A continuously-firing alert advances `last_firing_at` every evaluation
    // interval, so an open row that hasn't fired for several intervals means
    // the alert recovered in between and the close was missed (worker died
    // mid-tick). Because the episode is 1:1 with its issue, a stale open row is
    // a *previous* breach: it is retroactively closed at its `last_firing_at`
    // (the last moment we observed it firing) and a fresh row — a fresh
    // episode, and therefore a fresh issue — is inserted for the new breach.
    // A non-stale conflict is a concurrent duplicate and folds in place.
    async openOrContinueEpisode(input: EpisodeOpenInput): Promise<{ episodeId: string }> {
      const staleCutoff = new Date(
        input.startedAt.getTime() - Math.max(input.evaluationIntervalSeconds * 3, 60) * 1000,
      ).toISOString();
      const mergedPeak =
        input.comparator === "gt"
          ? sql`GREATEST(${schema.alertEpisodes.peakObservedValue}, excluded.peak_observed_value)`
          : sql`LEAST(${schema.alertEpisodes.peakObservedValue}, excluded.peak_observed_value)`;
      return db.transaction(async (tx) => {
        await tx
          .update(schema.alertEpisodes)
          .set({
            state: "resolved",
            endedAt: sql`${schema.alertEpisodes.lastFiringAt}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.alertEpisodes.alertId, input.alertId),
              eq(schema.alertEpisodes.groupKey, input.groupKey),
              eq(schema.alertEpisodes.state, "firing"),
              lt(schema.alertEpisodes.lastFiringAt, sql`${staleCutoff}::timestamptz`),
            ),
          );
        const rows = await tx
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
          })
          .onConflictDoUpdate({
            target: [schema.alertEpisodes.alertId, schema.alertEpisodes.groupKey],
            targetWhere: sql`state = 'firing'`,
            set: {
              // Concurrent duplicate of the same activation: keep the existing
              // start and accumulate.
              peakObservedValue: mergedPeak,
              lastObservedValue: sql`excluded.last_observed_value`,
              lastFiringAt: sql`excluded.last_firing_at`,
              updatedAt: new Date(),
            },
          })
          .returning({ id: schema.alertEpisodes.id });
        const episodeId = rows[0]?.id;
        if (!episodeId) throw new Error("failed to open alert episode");
        return { episodeId };
      });
    },

    // Create (or, on a retried tick, re-land on) the episode's issue. The
    // fingerprint is keyed to the episode id, so this is idempotent per
    // episode: a concurrent duplicate or a retry after a partial failure folds
    // into the same row. Also stamps the episode's issue link.
    async upsertEpisodeIssue(
      input: EpisodeIssueUpsertInput,
    ): Promise<{ issue: schema.Issue; inserted: boolean }> {
      const fingerprint = alertEpisodeFingerprint(input.episodeId);
      const seenAtIso = input.evaluatedAt.toISOString();
      const result = await db.execute<{ id: string; xmax: string }>(sql`
        INSERT INTO issues (
          project_id, fingerprint, kind, service, exception_type,
          title, message, top_frame, normalized_frames, last_sample,
          first_seen, last_seen, event_count
        ) VALUES (
          ${input.projectId}, ${fingerprint}, 'alert', ${input.service}, 'AlertFired',
          ${input.title}, ${input.title}, NULL, '[]'::jsonb, ${JSON.stringify(input.lastSample)}::jsonb,
          ${seenAtIso}::timestamptz, ${seenAtIso}::timestamptz, 1
        )
        -- See telemetry/ingest.ts: the WHERE clause is arbiter-index inference
        -- against the full unique index on (project_id, fingerprint).
        -- No event_count bump on conflict: a conflict here is a concurrent
        -- duplicate or a retry of the SAME opening tick, not a new occurrence;
        -- subsequent firing ticks are counted by touchOpenEpisode.
        ON CONFLICT (project_id, fingerprint) WHERE silenced_at IS NULL DO UPDATE SET
          last_seen = GREATEST(issues.last_seen, EXCLUDED.last_seen),
          last_sample = EXCLUDED.last_sample
        RETURNING id, xmax
      `);
      const raw = (result as unknown as Array<{ id: string; xmax: string }>)[0];
      const issue = await db.query.issues.findFirst({
        where: eq(schema.issues.id, raw?.id ?? ""),
      });
      if (!issue) throw new Error("failed to load issue after alert episode upsert");
      await db
        .update(schema.alertEpisodes)
        .set({ issueId: issue.id, updatedAt: new Date() })
        .where(eq(schema.alertEpisodes.id, input.episodeId));
      return { issue, inserted: raw?.xmax === "0" };
    },

    async setEpisodeIncident(episodeId: string, incidentId: string): Promise<void> {
      await db
        .update(schema.alertEpisodes)
        .set({ incidentId, updatedAt: new Date() })
        .where(eq(schema.alertEpisodes.id, episodeId));
    },

    // Serialize incident intake for one episode issue across concurrent worker
    // tasks. Racing duplicates fold into the same episode + issue, but intake's
    // existing-link check is read-then-create — unserialized racers could each
    // open an incident for the same issue. The advisory xact lock (released at
    // commit/rollback) makes the second racer wait until the first's intake has
    // committed its incident link, so it re-lands on that link instead.
    async withIssueIntakeLock<T>(issueId: string, fn: () => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${issueId}, 0))`);
        return fn();
      });
    },

    // Advance an open episode on a still-firing tick: update the latest value,
    // the most-severe value seen so far, and the last-firing timestamp — and
    // mirror the tick onto the episode's issue (the issue's last_seen /
    // event_count track the breach as it runs). One statement so the episode
    // and issue advance atomically — a partial write here couldn't be retried
    // (the episode row would already carry the new tick).
    async touchOpenEpisode(input: EpisodeTouchInput): Promise<void> {
      const evaluatedAtIso = input.evaluatedAt.toISOString();
      const peakExpr =
        input.comparator === "gt"
          ? sql`GREATEST(peak_observed_value, ${input.observedValue})`
          : sql`LEAST(peak_observed_value, ${input.observedValue})`;
      await db.execute(sql`
        WITH ep AS (
          UPDATE alert_episodes
          SET peak_observed_value = ${peakExpr},
              last_observed_value = ${input.observedValue},
              last_firing_at = ${evaluatedAtIso}::timestamptz,
              updated_at = now()
          WHERE alert_id = ${input.alertId}
            AND group_key = ${input.groupKey}
            AND state = 'firing'
          RETURNING issue_id
        )
        UPDATE issues
        SET last_seen = GREATEST(last_seen, ${evaluatedAtIso}::timestamptz),
            event_count = event_count + 1,
            last_sample = ${JSON.stringify(input.lastSample)}::jsonb
        WHERE id = (SELECT issue_id FROM ep WHERE issue_id IS NOT NULL)
      `);
    },

    // Close the open episode for an alert+group on recovery. The issue keeps
    // its own lifecycle (someone still has to resolve it); only its last_seen
    // is advanced to the breach end. One statement so the close and the issue
    // timestamp commit together — a close that landed without the issue update
    // would leave nothing for the retry to find (the row is no longer open).
    async closeOpenEpisode(input: EpisodeCloseInput): Promise<void> {
      const endedAtIso = input.endedAt.toISOString();
      await db.execute(sql`
        WITH ep AS (
          UPDATE alert_episodes
          SET state = 'resolved', ended_at = ${endedAtIso}::timestamptz, updated_at = now()
          WHERE alert_id = ${input.alertId}
            AND group_key = ${input.groupKey}
            AND state = 'firing'
          RETURNING issue_id
        )
        UPDATE issues
        SET last_seen = GREATEST(last_seen, ${endedAtIso}::timestamptz)
        WHERE id = (SELECT issue_id FROM ep WHERE issue_id IS NOT NULL)
      `);
    },

    async markEvaluated(alertId: string, evaluatedAt: Date): Promise<void> {
      await db
        .update(schema.alerts)
        .set({ lastEvaluatedAt: evaluatedAt })
        .where(eq(schema.alerts.id, alertId));
    },
  };
}
