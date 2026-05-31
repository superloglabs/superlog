import { type DB, schema } from "@superlog/db";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { CandidateIncident, ProposalToolInput } from "./domain.js";
import type { AutorecoveryPolicy } from "./policy.js";

const AUTORECOVERY_CURSOR_NAME = "autorecovery_last_run";

export type AutorecoveryRepository = ReturnType<typeof createAutorecoveryRepository>;

export type CandidateSelectionOptions = {
  ignoreThrottles?: boolean;
};

export function createAutorecoveryRepository(db: DB) {
  return {
    async getLastRunAt(): Promise<Date | null> {
      const row = await db.query.workerState.findFirst({
        where: eq(schema.workerState.name, AUTORECOVERY_CURSOR_NAME),
      });
      return row?.cursor ?? null;
    },

    async setLastRunAt(at: Date): Promise<void> {
      await db
        .insert(schema.workerState)
        .values({ name: AUTORECOVERY_CURSOR_NAME, cursor: at, updatedAt: at })
        .onConflictDoUpdate({
          target: schema.workerState.name,
          set: { cursor: at, updatedAt: at },
        });
    },

    async selectCandidates(
      now: Date,
      policy: Pick<
        AutorecoveryPolicy,
        | "skipRecentActivityMs"
        | "skipRecentlyCreatedMs"
        | "dismissalCooldownMs"
        | "reevaluationCooldownMs"
        | "maxCandidatesPerTick"
      >,
      opts: CandidateSelectionOptions = {},
    ): Promise<CandidateIncident[]> {
      const activityCutoff = new Date(now.getTime() - policy.skipRecentActivityMs);
      const createdCutoff = new Date(now.getTime() - policy.skipRecentlyCreatedMs);
      const dismissalCutoff = new Date(now.getTime() - policy.dismissalCooldownMs);
      const reevaluationCutoff = new Date(now.getTime() - policy.reevaluationCooldownMs);
      const ignoreThrottles = opts.ignoreThrottles ?? false;

      // Drizzle's typing for partial selects with $type<>() is finicky inside
      // exists-subqueries; raw SQL is cleaner for the "no recent proposal"
      // and "no live re-investigation pending" gates.
      const rows = await db
        .select({
          id: schema.incidents.id,
          projectId: schema.incidents.projectId,
          title: schema.incidents.title,
          codename: schema.incidents.codename,
          service: schema.incidents.service,
          firstSeen: schema.incidents.firstSeen,
          lastSeen: schema.incidents.lastSeen,
          issueCount: schema.incidents.issueCount,
          // Aggregate distinct exception types for live (non-silenced) issues
          // linked to the incident. Used downstream to scope the CH
          // "is the underlying error still firing" query.
          // Correlate with the outer row via the literal `incidents.id`. Inside
          // this projection subquery both `ii` and `i` are in scope, so the
          // drizzle column ref `${schema.incidents.id}` renders as a bare,
          // ambiguous `"id"` and Postgres aborts the whole query (42702). The
          // qualified table name is unambiguous.
          exceptionTypes: sql<string[]>`COALESCE((
            SELECT array_agg(DISTINCT i.exception_type)
            FROM incident_issues ii
            JOIN issues i ON i.id = ii.issue_id
            WHERE ii.incident_id = incidents.id
              AND i.silenced_at IS NULL
          ), ARRAY[]::text[])`,
          slackChannelId: schema.incidents.slackChannelId,
          slackThreadTs: schema.incidents.slackThreadTs,
          slackInstallationId: schema.incidents.slackInstallationId,
        })
        .from(schema.incidents)
        .where(
          and(
            eq(schema.incidents.status, "open"),
            ignoreThrottles ? sql`true` : lt(schema.incidents.lastSeen, activityCutoff),
            ignoreThrottles ? sql`true` : lt(schema.incidents.createdAt, createdCutoff),
            // An incident with no live linked issues has nothing for the
            // agent to query against. Filtering here means the agent never
            // sees a degenerate candidate that would look "recovered" purely
            // because there's no signal to count.
            sql`EXISTS (
              SELECT 1 FROM incident_issues ii
              JOIN issues i ON i.id = ii.issue_id
              WHERE ii.incident_id = ${schema.incidents.id}
                AND i.silenced_at IS NULL
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM incident_resolution_proposals p
              WHERE p.incident_id = ${schema.incidents.id}
                AND p.decision IS NULL
            )`,
            // dismissalCutoff is interpolated as an ISO string because Drizzle's
            // raw `sql` tag passes a JS `Date` through `String(...)`, producing
            // a "Wed May 20 2026 ... GMT-0700" Postgres can't parse.
            ignoreThrottles
              ? sql`true`
              : sql`NOT EXISTS (
                  SELECT 1 FROM incident_resolution_proposals p
                  WHERE p.incident_id = ${schema.incidents.id}
                    AND p.decision = 'dismissed'
                    AND p.decided_at > ${dismissalCutoff.toISOString()}::timestamptz
                )`,
            // Skip incidents the sweep already evaluated within the cooldown so
            // a single tick rotates onward through the backlog instead of
            // re-chewing the same slice. `ignoreThrottles` (manual/forced runs)
            // bypasses this so an operator can re-run on demand.
            ignoreThrottles
              ? sql`true`
              : or(
                  isNull(schema.incidents.autorecoveryLastEvaluatedAt),
                  lt(schema.incidents.autorecoveryLastEvaluatedAt, reevaluationCutoff),
                ),
          ),
        )
        // Least-recently-evaluated first (never-evaluated sorts first), then
        // stalest incident first — the longest-quiet incidents are the best
        // autoresolve candidates and shouldn't starve behind freshly-quiet ones.
        .orderBy(
          sql`${schema.incidents.autorecoveryLastEvaluatedAt} ASC NULLS FIRST`,
          asc(schema.incidents.lastSeen),
        )
        .limit(policy.maxCandidatesPerTick);

      return rows.map(({ exceptionTypes, ...rest }) => ({
        ...rest,
        issueSignatures: (exceptionTypes ?? []).map((exceptionType) => ({
          exceptionType,
        })),
      }));
    },

    // Stamp the sweep's "last looked at this incident" cursor. Called for every
    // candidate the tick processes, whatever the outcome, so the NULLS-FIRST
    // ordering rotates past it next time and the backlog drains fairly.
    async markEvaluated(incidentId: string, at: Date): Promise<void> {
      await db
        .update(schema.incidents)
        .set({ autorecoveryLastEvaluatedAt: at })
        .where(eq(schema.incidents.id, incidentId));
    },

    async findProject(projectId: string) {
      return db.query.projects.findFirst({
        where: eq(schema.projects.id, projectId),
        columns: { id: true, orgId: true, name: true },
      });
    },

    async findOpenProposalForIncident(incidentId: string) {
      return db.query.incidentResolutionProposals.findFirst({
        where: and(
          eq(schema.incidentResolutionProposals.incidentId, incidentId),
          isNull(schema.incidentResolutionProposals.decision),
        ),
      });
    },

    async insertProposal(input: {
      incident: CandidateIncident;
      proposal: ProposalToolInput;
    }): Promise<schema.IncidentResolutionProposal | null> {
      const [row] = await db
        .insert(schema.incidentResolutionProposals)
        .values({
          incidentId: input.incident.id,
          sourceKind: "autorecovery",
          proposedReasonCode: input.proposal.reason_code,
          proposedReasonText: input.proposal.reason_text,
          confidence: input.proposal.confidence,
          evidence: input.proposal.evidence_summary
            ? { summary: input.proposal.evidence_summary }
            : null,
          slackInstallationId: input.incident.slackInstallationId,
          slackChannelId: input.incident.slackChannelId,
        })
        .returning();
      return row ?? null;
    },

    async setProposalSlackMessageTs(proposalId: string, ts: string): Promise<void> {
      await db
        .update(schema.incidentResolutionProposals)
        .set({ slackMessageTs: ts })
        .where(eq(schema.incidentResolutionProposals.id, proposalId));
    },

    async findSlackInstallation(id: string): Promise<schema.SlackInstallation | undefined> {
      return db.query.slackInstallations.findFirst({
        where: eq(schema.slackInstallations.id, id),
      });
    },
  };
}
