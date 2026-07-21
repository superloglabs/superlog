import { type DB, type IssueSample, db as defaultDb, schema } from "@superlog/db";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type {
  PendingSentryIssueEvent,
  SentryIssueIngestRepository,
  SentryIssueOccurrence,
} from "./ingest.js";

export function createDrizzleSentryIssueIngestRepository(
  database: DB = defaultDb,
): SentryIssueIngestRepository {
  return {
    async claimPending(limit) {
      const rows = await database
        .select({
          id: schema.sentryWebhookEvents.id,
          projectId: schema.sentryInstallations.projectId,
          organizationSlug: schema.sentryInstallations.organizationSlug,
          sentryProjectSlug: schema.sentryInstallations.sentryProjectSlug,
          action: schema.sentryWebhookEvents.action,
          sentryIssueId: schema.sentryWebhookEvents.sentryIssueId,
          title: schema.sentryWebhookEvents.title,
          culprit: schema.sentryWebhookEvents.culprit,
          level: schema.sentryWebhookEvents.level,
          firstSeen: schema.sentryWebhookEvents.firstSeen,
          lastSeen: schema.sentryWebhookEvents.lastSeen,
          eventCount: schema.sentryWebhookEvents.eventCount,
          issueUrl: schema.sentryWebhookEvents.issueUrl,
        })
        .from(schema.sentryWebhookEvents)
        .innerJoin(
          schema.sentryInstallations,
          eq(schema.sentryWebhookEvents.installationId, schema.sentryInstallations.id),
        )
        .where(
          and(
            isNull(schema.sentryInstallations.revokedAt),
            or(
              eq(schema.sentryWebhookEvents.status, "pending"),
              and(
                eq(schema.sentryWebhookEvents.status, "failed"),
                lt(schema.sentryWebhookEvents.attemptCount, 10),
              ),
            ),
          ),
        )
        .orderBy(asc(schema.sentryWebhookEvents.receivedAt))
        .limit(limit);
      return rows satisfies PendingSentryIssueEvent[];
    },

    async prepareIssue(eventId, occurrence) {
      return database.transaction(async (tx) => {
        const [event] = await tx
          .select({
            transition: schema.sentryWebhookEvents.transition,
            issueId: schema.sentryWebhookEvents.issueId,
          })
          .from(schema.sentryWebhookEvents)
          .where(eq(schema.sentryWebhookEvents.id, eventId))
          .for("update");
        if (!event) throw new Error("Sentry webhook event disappeared while preparing issue");

        if (event.transition) {
          if (event.transition !== "new" && event.transition !== "recurred") {
            return { transition: event.transition, issue: null };
          }
          const issue = event.issueId
            ? await tx.query.issues.findFirst({ where: eq(schema.issues.id, event.issueId) })
            : null;
          if (!issue) throw new Error("failed to reload prepared Sentry issue");
          return { transition: event.transition, issue };
        }

        const prepared = await upsertSentryIssue(tx, occurrence);
        await tx
          .update(schema.sentryWebhookEvents)
          .set({ transition: prepared.transition, issueId: prepared.issue?.id ?? null })
          .where(eq(schema.sentryWebhookEvents.id, eventId));
        return prepared;
      });
    },

    async markProcessed(eventId) {
      await database
        .update(schema.sentryWebhookEvents)
        .set({ status: "processed", processedAt: new Date(), lastError: null })
        .where(eq(schema.sentryWebhookEvents.id, eventId));
    },

    async markFailed(eventId, error) {
      await database
        .update(schema.sentryWebhookEvents)
        .set({
          status: "failed",
          attemptCount: sql`${schema.sentryWebhookEvents.attemptCount} + 1`,
          lastError: error.slice(0, 4_000),
        })
        .where(eq(schema.sentryWebhookEvents.id, eventId));
    },
  };
}

type SentryIssueDatabase = Pick<DB, "execute" | "query">;

async function upsertSentryIssue(database: SentryIssueDatabase, occurrence: SentryIssueOccurrence) {
  const sample: IssueSample = {
    kind: "log",
    service: occurrence.service,
    severity: occurrence.severity,
    message: occurrence.message,
    body: occurrence.title,
    exceptionType: occurrence.exceptionType,
    topFrame: null,
    normalizedFrames: [],
    stacktrace: null,
    seenAt: occurrence.lastSeen.toISOString(),
    resourceAttrs: occurrence.resourceAttrs,
  };
  const result = await database.execute<{
    id: string;
    xmax: string;
    prev_issue_id: string | null;
    prev_issue_status: string | null;
  }>(sql`
    WITH prev AS (
      SELECT i.id AS issue_id, i.status AS issue_status
      FROM issues i
      WHERE i.project_id = ${occurrence.projectId}
        AND i.fingerprint = ${occurrence.fingerprint}
      LIMIT 1
    ),
    up AS (
      INSERT INTO issues (
        project_id, fingerprint, kind, service, exception_type,
        title, message, normalized_frames, last_sample,
        first_seen, last_seen, event_count
      ) VALUES (
        ${occurrence.projectId}, ${occurrence.fingerprint}, 'sentry', ${occurrence.service},
        ${occurrence.exceptionType}, ${occurrence.title}, ${occurrence.message}, '[]'::jsonb,
        ${JSON.stringify(sample)}::jsonb, ${occurrence.firstSeen.toISOString()}::timestamptz,
        ${occurrence.lastSeen.toISOString()}::timestamptz, ${occurrence.eventCount}
      )
      ON CONFLICT (project_id, fingerprint) WHERE silenced_at IS NULL DO UPDATE SET
        last_seen = GREATEST(issues.last_seen, EXCLUDED.last_seen),
        first_seen = LEAST(issues.first_seen, EXCLUDED.first_seen),
        event_count = GREATEST(issues.event_count, EXCLUDED.event_count),
        title = EXCLUDED.title,
        message = COALESCE(EXCLUDED.message, issues.message),
        service = EXCLUDED.service,
        last_sample = EXCLUDED.last_sample
      RETURNING id, xmax
    )
    SELECT
      (SELECT id::text FROM up) AS id,
      (SELECT xmax::text FROM up) AS xmax,
      (SELECT issue_id::text FROM prev) AS prev_issue_id,
      (SELECT issue_status FROM prev) AS prev_issue_status
  `);
  type UpsertRow = {
    id: string;
    xmax: string;
    prev_issue_id: string | null;
    prev_issue_status: string | null;
  };
  const rawResult = result as unknown as UpsertRow[] | { rows: UpsertRow[] };
  const row = (Array.isArray(rawResult) ? rawResult : rawResult.rows)[0];
  const transition = classifyTransition({
    action: occurrence.action,
    inserted: row?.xmax === "0",
    previousId: row?.prev_issue_id ?? null,
    previousStatus: row?.prev_issue_status ?? null,
  });
  if (transition !== "new" && transition !== "recurred") {
    return { transition, issue: null } as const;
  }
  const issue = await database.query.issues.findFirst({
    where: eq(schema.issues.id, row?.id ?? ""),
  });
  if (!issue) throw new Error("failed to load Sentry issue after upsert");
  return { transition, issue } as const;
}

function classifyTransition(input: {
  action: "created" | "unresolved";
  inserted: boolean;
  previousId: string | null;
  previousStatus: string | null;
}): "new" | "recurred" | "suppressed" | "seen" {
  if (input.inserted || input.previousId === null) return "new";
  if (input.previousStatus === "silenced" || input.previousStatus === "under_observation") {
    return "suppressed";
  }
  if (input.action === "unresolved" && input.previousStatus === "resolved") return "recurred";
  return "seen";
}
