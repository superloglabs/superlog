import {
  type DB,
  type LinkIssueToOpenIncidentResult,
  buildIssueReopenPatch,
  createIncidentLifecycle,
  db,
  schema,
} from "@superlog/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { IssueGroupingSource, IssueGroupingState, LinkedIncidentIssue } from "./domain.js";

const INCIDENT_GROUPING_CANDIDATE_LIMIT = parsePositiveInt(
  process.env.INCIDENT_GROUPING_CANDIDATE_LIMIT,
  200,
  1000,
);

const incidentLifecycle = createIncidentLifecycle(db);

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function updateIssueGrouping(
  issueId: string,
  opts: {
    state: IssueGroupingState;
    source?: IssueGroupingSource;
    reason?: string | null;
    incrementAttempt?: boolean;
    // Only apply when the current state is 'pending' — used by a losing
    // concurrent-intake racer to clear its own in-flight marker without
    // clobbering the winner's recorded grouping verdict.
    onlyIfPending?: boolean;
    // Only apply when grouping isn't already decided: either untouched
    // (source IS NULL on a fresh issue) or in a retryable state
    // ('pending'/'failed'). Used by the out-of-lock 'pending' marker write so a
    // losing concurrent racer can never overwrite the winner's recorded
    // grouped/standalone verdict (which always carries a non-null source). A
    // single-row predicate, so it re-evaluates correctly under READ COMMITTED
    // when it contends with the winner's verdict write on the same row.
    onlyIfUndecided?: boolean;
  },
  // Injectable for tests; defaults to the shared connection.
  database: DB = db,
): Promise<void> {
  await database
    .update(schema.issues)
    .set({
      groupingState: opts.state,
      groupingSource: opts.source,
      groupingReason: opts.reason ?? null,
      groupingAttemptedAt: new Date(),
      ...(opts.incrementAttempt
        ? { groupingAttemptCount: sql`${schema.issues.groupingAttemptCount} + 1` }
        : {}),
    })
    .where(
      opts.onlyIfPending
        ? and(eq(schema.issues.id, issueId), eq(schema.issues.groupingState, "pending"))
        : opts.onlyIfUndecided
          ? and(
              eq(schema.issues.id, issueId),
              or(
                isNull(schema.issues.groupingSource),
                inArray(schema.issues.groupingState, ["pending", "failed"]),
              ),
            )
          : eq(schema.issues.id, issueId),
    );
}

export async function findOpenIncidentCandidates(
  issue: schema.Issue,
  opts: { filterService: boolean },
): Promise<schema.Incident[]> {
  return db.query.incidents.findMany({
    where: and(
      eq(schema.incidents.projectId, issue.projectId),
      eq(schema.incidents.status, "open"),
      opts.filterService && issue.service
        ? or(eq(schema.incidents.service, issue.service), isNull(schema.incidents.service))
        : undefined,
    ),
    orderBy: [desc(schema.incidents.lastSeen)],
    limit: INCIDENT_GROUPING_CANDIDATE_LIMIT,
  });
}

export async function loadLinkedIncidentIssues(
  incidents: schema.Incident[],
): Promise<LinkedIncidentIssue[]> {
  if (incidents.length === 0) return [];
  return db
    .select({
      incidentId: schema.incidentIssues.incidentId,
      title: schema.issues.title,
      exceptionType: schema.issues.exceptionType,
      message: schema.issues.message,
      topFrame: schema.issues.topFrame,
      normalizedFrames: schema.issues.normalizedFrames,
      lastSample: schema.issues.lastSample,
      lastSeen: schema.issues.lastSeen,
    })
    .from(schema.incidentIssues)
    .innerJoin(schema.issues, eq(schema.issues.id, schema.incidentIssues.issueId))
    .where(
      inArray(
        schema.incidentIssues.incidentId,
        incidents.map((incident) => incident.id),
      ),
    );
}

export async function findProject(projectId: string): Promise<schema.Project | undefined> {
  return db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
  });
}

// An issue accumulates one incident_issues link per incident it has driven
// (recurrence appends a new link); the newest link is its current incident.
export async function findLatestIncidentIssueLink(
  issueId: string,
): Promise<schema.IncidentIssue | undefined> {
  return db.query.incidentIssues.findFirst({
    where: eq(schema.incidentIssues.issueId, issueId),
    orderBy: [desc(schema.incidentIssues.createdAt), desc(schema.incidentIssues.id)],
  });
}

export async function touchIncidentLastSeen(incidentId: string, lastSeen: Date): Promise<void> {
  await db
    .update(schema.incidents)
    .set({
      lastSeen: sql`GREATEST(${schema.incidents.lastSeen}, ${lastSeen.toISOString()}::timestamptz)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.incidents.id, incidentId));
}

export async function findIncident(incidentId: string): Promise<schema.Incident | undefined> {
  return db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
}

// A resolved incident can have several issue fingerprints recur at once. They
// all belong to one successor investigation, so intake reuses the newest open
// successor instead of opening one recurrence per fingerprint.
export async function findOpenRecurrenceForIncident(
  previousIncidentId: string,
): Promise<schema.Incident | undefined> {
  return db.query.incidents.findFirst({
    where: and(
      eq(schema.incidents.previousIncidentId, previousIncidentId),
      eq(schema.incidents.status, "open"),
    ),
    orderBy: [desc(schema.incidents.createdAt)],
  });
}

export async function reopenIssue(issueId: string): Promise<void> {
  await db.update(schema.issues).set(buildIssueReopenPatch()).where(eq(schema.issues.id, issueId));
}

// The episode an alert-episode issue is 1:1 with (alert_episodes_issue_uniq
// enforces the 1:1). Carries the alert identity used for same-alert grouping.
export async function findAlertEpisodeForIssue(
  issueId: string,
): Promise<schema.AlertEpisode | undefined> {
  return db.query.alertEpisodes.findFirst({
    where: eq(schema.alertEpisodes.issueId, issueId),
  });
}

// Serialize incident intake across concurrent worker tasks. The keys represent
// every correlation boundary chosen by the application workflow: issue, trace,
// and/or predecessor incident. Acquiring unique keys in lexical order avoids
// deadlocks when concurrent intakes overlap on only one boundary. The advisory
// xact locks are released at commit/rollback. Callers keep notifications and
// other slow side effects OUTSIDE fn — the lock holds a database connection
// open for fn's whole duration.
export async function withIssueIntakeLock<T>(
  keys: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    for (const key of [...new Set(keys)].sort()) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    }
    return fn();
  });
}

// Newest incident driven by an episode of the same alert+group, optionally
// restricted to open incidents. Single query shape so the open-join and
// latest-predecessor lookups can't drift apart.
async function findNewestIncidentForAlert(
  alertId: string,
  groupKey: string,
  opts: { openOnly: boolean },
): Promise<schema.Incident | undefined> {
  const rows = await db
    .select({ incident: schema.incidents })
    .from(schema.alertEpisodes)
    .innerJoin(schema.incidents, eq(schema.incidents.id, schema.alertEpisodes.incidentId))
    .where(
      and(
        eq(schema.alertEpisodes.alertId, alertId),
        eq(schema.alertEpisodes.groupKey, groupKey),
        opts.openOnly ? eq(schema.incidents.status, "open") : undefined,
      ),
    )
    .orderBy(desc(schema.alertEpisodes.startedAt))
    .limit(1);
  return rows[0]?.incident;
}

// Newest open incident driven by an episode of the same alert+group — the
// join target for a new breach while the previous one is still being handled.
export async function findOpenIncidentForAlert(
  alertId: string,
  groupKey: string,
): Promise<schema.Incident | undefined> {
  return findNewestIncidentForAlert(alertId, groupKey, { openOnly: true });
}

// Newest incident (any status) driven by an episode of the same alert+group —
// the predecessor a standalone new breach chains to when it's closed.
export async function findLatestIncidentForAlert(
  alertId: string,
  groupKey: string,
): Promise<schema.Incident | undefined> {
  return findNewestIncidentForAlert(alertId, groupKey, { openOnly: false });
}

export async function linkIssueToIncident(opts: {
  incident: schema.Incident;
  issue: schema.Issue;
}): Promise<LinkIssueToOpenIncidentResult> {
  return incidentLifecycle.linkIssueToOpenIncident({
    incidentId: opts.incident.id,
    issue: opts.issue,
  });
}
