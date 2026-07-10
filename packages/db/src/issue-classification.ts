// Per-issue classification applied mid-run by the investigation agent's
// action tools (silence_as_noise / place_under_observation / resolve_issue).
// Unlike the incident-resolution cascade in resolve-incident.ts — which
// disposes of every linked issue at once when an incident closes — this
// classifies ONE issue while the incident stays open, so the agent can work
// through a grouped incident issue by issue and only then resolve it.

import { and, eq } from "drizzle-orm";
import { type DB, db } from "./client.js";
import {
  buildIssueObservePatch,
  buildIssueResolvePatch,
  buildIssueSilencePatch,
} from "./issue-state.js";
import * as schema from "./schema.js";

export type IssueClassificationAction =
  | { kind: "silence" }
  | { kind: "observe"; trigger: schema.IssueEscalationTrigger }
  | { kind: "resolve" };

const TARGET_STATUS: Record<IssueClassificationAction["kind"], schema.IssueStatus> = {
  silence: "silenced",
  observe: "under_observation",
  resolve: "resolved",
};

export type ClassifyIncidentIssueResult =
  | { ok: true; issueTitle: string; status: schema.IssueStatus; alreadyClassified: boolean }
  | {
      ok: false;
      error: "issue_not_found" | "not_linked_to_incident" | "alert_issue_not_suppressible";
      message: string;
    };

// Classify a single issue linked to an open incident. Idempotent: an issue
// already in the target status reports alreadyClassified instead of failing,
// so a re-dispatched tool call (ack lost, worker retried) converges.
export async function classifyIncidentIssue(
  database: DB = db,
  opts: {
    incidentId: string;
    issueId: string;
    agentRunId?: string | null;
    action: IssueClassificationAction;
    reason: string;
    evidence: string;
    now?: Date;
  },
): Promise<ClassifyIncidentIssueResult> {
  const now = opts.now ?? new Date();

  return database.transaction(async (tx) => {
    const issue = await tx.query.issues.findFirst({
      where: eq(schema.issues.id, opts.issueId),
    });
    if (!issue) {
      return {
        ok: false as const,
        error: "issue_not_found" as const,
        message: `No issue with id ${opts.issueId}. Use an issue_id from the incident issue bundle.`,
      };
    }
    const link = await tx.query.incidentIssues.findFirst({
      where: and(
        eq(schema.incidentIssues.incidentId, opts.incidentId),
        eq(schema.incidentIssues.issueId, opts.issueId),
      ),
    });
    if (!link) {
      return {
        ok: false as const,
        error: "not_linked_to_incident" as const,
        message: `Issue ${opts.issueId} is not linked to this incident. Only classify issues from the incident issue bundle.`,
      };
    }
    // Alert-episode issues track an alert breach period; suppressing future
    // breaches is an alert-configuration decision, not an issue verdict. They
    // can only be resolved.
    if (issue.kind === "alert" && opts.action.kind !== "resolve") {
      return {
        ok: false as const,
        error: "alert_issue_not_suppressible" as const,
        message: `Issue ${opts.issueId} is an alert episode — it can only be resolved (resolve_issue), not silenced or observed.`,
      };
    }

    const targetStatus = TARGET_STATUS[opts.action.kind];
    if (issue.status === targetStatus) {
      return {
        ok: true as const,
        issueTitle: issue.title,
        status: targetStatus,
        alreadyClassified: true,
      };
    }

    const patch =
      opts.action.kind === "silence"
        ? buildIssueSilencePatch(now)
        : opts.action.kind === "observe"
          ? buildIssueObservePatch({
              trigger: opts.action.trigger,
              baselineEventCount: issue.eventCount,
              now,
            })
          : buildIssueResolvePatch();
    await tx.update(schema.issues).set(patch).where(eq(schema.issues.id, opts.issueId));

    const eventKind =
      opts.action.kind === "silence"
        ? "issue_silenced"
        : opts.action.kind === "observe"
          ? "issue_observed"
          : "issue_resolved";
    await tx
      .insert(schema.incidentEvents)
      .values({
        agentRunId: opts.agentRunId ?? null,
        incidentId: opts.incidentId,
        kind: eventKind,
        summary:
          opts.action.kind === "silence"
            ? `Issue silenced: ${issue.title}`
            : opts.action.kind === "observe"
              ? `Issue placed under observation: ${issue.title}`
              : `Issue resolved: ${issue.title}`,
        detail: {
          issueId: issue.id,
          issueTitle: issue.title,
          reason: opts.reason,
          evidence: opts.evidence,
          ...(opts.action.kind === "observe"
            ? { trigger: opts.action.trigger, baselineEventCount: issue.eventCount }
            : {}),
        },
        dedupeKey: `${eventKind}:${issue.id}:${now.getTime()}`,
        processedAt: now,
      })
      .onConflictDoNothing();

    return {
      ok: true as const,
      issueTitle: issue.title,
      status: targetStatus,
      alreadyClassified: false,
    };
  });
}

// Issues still `open` on the incident — the resolve_incident guard: the
// terminal call is rejected until this list is empty.
export async function listUnclassifiedIncidentIssues(
  database: DB = db,
  incidentId: string,
): Promise<Array<{ id: string; title: string }>> {
  const rows = await database
    .select({ id: schema.issues.id, title: schema.issues.title, status: schema.issues.status })
    .from(schema.issues)
    .innerJoin(schema.incidentIssues, eq(schema.incidentIssues.issueId, schema.issues.id))
    .where(eq(schema.incidentIssues.incidentId, incidentId));
  return rows.filter((row) => row.status === "open").map(({ id, title }) => ({ id, title }));
}
