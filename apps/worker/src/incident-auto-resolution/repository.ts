import { type DB, createIncidentLifecycle } from "@superlog/db";
import { sql } from "drizzle-orm";
import type { QuietIncidentCandidate } from "./domain.js";
import type { QuietIncidentResolveResult } from "./sweep.js";

type CandidateRow = {
  incident_id: string;
  issue_id: string;
  issue_last_seen: Date | string;
};

function rowsFromResult<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] } | null)?.rows ?? []);
}

export function createQuietIncidentResolutionRepository(database: DB) {
  const lifecycle = createIncidentLifecycle(database);
  return {
    async listCandidates(cutoff: Date): Promise<QuietIncidentCandidate[]> {
      const result = await database.execute<CandidateRow>(sql`
        SELECT inc.id AS incident_id,
               i.id AS issue_id,
               i.last_seen AS issue_last_seen
        FROM incidents inc
        LEFT JOIN project_automation_settings automation
          ON automation.project_id = inc.project_id
        JOIN incident_issues ii
          ON ii.incident_id = inc.id
        JOIN issues i
          ON i.id = ii.issue_id
        WHERE inc.status = 'open'
          AND inc.last_seen <= ${cutoff.toISOString()}::timestamptz
          AND COALESCE(automation.auto_resolve_stale_incidents_enabled, true)
          AND NOT EXISTS (
            SELECT 1
            FROM incident_issues newer
            WHERE newer.issue_id = i.id
              AND (newer.created_at, newer.id) > (ii.created_at, ii.id)
          )
        ORDER BY inc.id, i.id
      `);
      const candidates = new Map<string, QuietIncidentCandidate>();
      for (const row of rowsFromResult<CandidateRow>(result)) {
        const candidate = candidates.get(row.incident_id) ?? {
          incidentId: row.incident_id,
          linkedIssues: [],
        };
        candidate.linkedIssues.push({
          id: row.issue_id,
          lastSeen:
            row.issue_last_seen instanceof Date
              ? row.issue_last_seen
              : new Date(row.issue_last_seen),
        });
        candidates.set(row.incident_id, candidate);
      }
      return [...candidates.values()];
    },

    async resolveIfStillQuiet(input: {
      incidentId: string;
      cutoff: Date;
      resolvedAt: Date;
    }): Promise<QuietIncidentResolveResult> {
      const result = await lifecycle.resolveIfAllIssuesQuiet({
        ...input,
        kind: "auto_inactivity",
        reasonCode: "no_issue_recurrence_14d",
        reasonText: "No linked issue recurred for 14 days.",
        eventSummary: "Incident automatically resolved after 14 days without issue recurrence.",
      });
      return result.disposition === "incident_not_open"
        ? { kind: "not_open" }
        : result.disposition === "resolved"
          ? {
              kind: "resolved",
              linkedIssueCount: result.linkedIssueCount,
              quietSince: result.quietSince,
            }
          : { kind: result.disposition };
    },
  };
}
