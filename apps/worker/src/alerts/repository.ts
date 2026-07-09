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
        ON CONFLICT (project_id, fingerprint) WHERE silenced_at IS NULL DO UPDATE SET
          last_seen = GREATEST(issues.last_seen, EXCLUDED.last_seen),
          event_count = issues.event_count + 1,
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

    // Advance an open episode on a still-firing tick: update the latest value,
    // the most-severe value seen so far, and the last-firing timestamp — and
    // mirror the tick onto the episode's issue (the issue's last_seen /
    // event_count track the breach as it runs).
    async touchOpenEpisode(input: EpisodeTouchInput): Promise<void> {
      const peakExpr =
        input.comparator === "gt"
          ? sql`GREATEST(${schema.alertEpisodes.peakObservedValue}, ${input.observedValue})`
          : sql`LEAST(${schema.alertEpisodes.peakObservedValue}, ${input.observedValue})`;
      const rows = await db
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
        )
        .returning({ issueId: schema.alertEpisodes.issueId });
      const issueId = rows[0]?.issueId;
      if (!issueId) return;
      await db
        .update(schema.issues)
        .set({
          lastSeen: sql`GREATEST(${schema.issues.lastSeen}, ${input.evaluatedAt.toISOString()}::timestamptz)`,
          eventCount: sql`${schema.issues.eventCount} + 1`,
          lastSample: input.lastSample,
        })
        .where(eq(schema.issues.id, issueId));
    },

    // Close the open episode for an alert+group on recovery. The issue keeps
    // its own lifecycle (someone still has to resolve it); only its last_seen
    // is advanced to the breach end.
    async closeOpenEpisode(input: EpisodeCloseInput): Promise<void> {
      const rows = await db
        .update(schema.alertEpisodes)
        .set({ state: "resolved", endedAt: input.endedAt, updatedAt: new Date() })
        .where(
          and(
            eq(schema.alertEpisodes.alertId, input.alertId),
            eq(schema.alertEpisodes.groupKey, input.groupKey),
            eq(schema.alertEpisodes.state, "firing"),
          ),
        )
        .returning({ issueId: schema.alertEpisodes.issueId });
      const issueId = rows[0]?.issueId;
      if (!issueId) return;
      await db
        .update(schema.issues)
        .set({
          lastSeen: sql`GREATEST(${schema.issues.lastSeen}, ${input.endedAt.toISOString()}::timestamptz)`,
        })
        .where(eq(schema.issues.id, issueId));
    },

    async markEvaluated(alertId: string, evaluatedAt: Date): Promise<void> {
      await db
        .update(schema.alerts)
        .set({ lastEvaluatedAt: evaluatedAt })
        .where(eq(schema.alerts.id, alertId));
    },
  };
}
