import { db, schema } from "@superlog/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { IssueGroupingSource, IssueGroupingState, LinkedIncidentIssue } from "./domain.js";

const INCIDENT_GROUPING_CANDIDATE_LIMIT = parsePositiveInt(
  process.env.INCIDENT_GROUPING_CANDIDATE_LIMIT,
  200,
  1000,
);

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
  },
): Promise<void> {
  await db
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
    .where(eq(schema.issues.id, issueId));
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

// The episode an alert-episode issue is 1:1 with (alert_episodes_issue_uniq
// enforces the 1:1). Carries the alert identity used for same-alert grouping.
export async function findAlertEpisodeForIssue(
  issueId: string,
): Promise<schema.AlertEpisode | undefined> {
  return db.query.alertEpisodes.findFirst({
    where: eq(schema.alertEpisodes.issueId, issueId),
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
}): Promise<boolean> {
  const inserted = await db
    .insert(schema.incidentIssues)
    .values({ incidentId: opts.incident.id, issueId: opts.issue.id })
    .onConflictDoNothing()
    .returning();
  if (!inserted[0]) return false;
  await db
    .update(schema.incidents)
    .set({
      lastSeen: sql`GREATEST(${schema.incidents.lastSeen}, ${opts.issue.lastSeen.toISOString()}::timestamptz)`,
      issueCount: sql`${schema.incidents.issueCount} + 1`,
      service: opts.incident.service ?? opts.issue.service,
      updatedAt: new Date(),
    })
    .where(eq(schema.incidents.id, opts.incident.id));
  return true;
}
