// Per-issue classification applied mid-run by the investigation agent's
// action tools (silence_as_noise / place_under_observation / resolve_issue).
// Unlike the incident-resolution cascade in resolve-incident.ts — which
// disposes of every linked issue at once when an incident closes — this
// classifies ONE issue while the incident stays open, so the agent can work
// through a grouped incident issue by issue and only then resolve it.

import { desc, eq, inArray } from "drizzle-orm";
import type { DB } from "./client.js";
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function classifyIncidentIssue(
  database: DB,
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

  if (!UUID_RE.test(opts.issueId)) {
    return {
      ok: false as const,
      error: "issue_not_found" as const,
      message: `No issue with id ${opts.issueId}. Use an issue_id from the incident issue bundle.`,
    };
  }

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
    // An issue accumulates one link per incident over its life (recurrence
    // appends a new link), so "belongs to this incident" means the NEWEST
    // link points here — mirroring listCurrentIssuesForIncidentInTx. A stale
    // resumed run must not classify an issue that already recurred into a
    // newer incident; that verdict belongs to the newer investigation.
    const latestLink = await tx.query.incidentIssues.findFirst({
      where: eq(schema.incidentIssues.issueId, opts.issueId),
      orderBy: [desc(schema.incidentIssues.createdAt), desc(schema.incidentIssues.id)],
    });
    if (latestLink?.incidentId !== opts.incidentId) {
      return {
        ok: false as const,
        error: "not_linked_to_incident" as const,
        message: latestLink
          ? `Issue ${opts.issueId} now belongs to a newer incident; it can no longer be classified from this one. Only classify issues from the incident issue bundle.`
          : `Issue ${opts.issueId} is not linked to this incident. Only classify issues from the incident issue bundle.`,
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

// Issues still `open` whose CURRENT incident is this one — the
// resolve_incident guard: the terminal call is rejected until this list is
// empty. Same newest-link-wins semantics as classifyIncidentIssue: an issue
// that already recurred into a newer incident is that investigation's to
// classify and must not block this incident's resolution.
export async function listUnclassifiedIncidentIssues(
  database: DB,
  incidentId: string,
): Promise<Array<{ id: string; title: string }>> {
  const rows = await database
    .select({ id: schema.issues.id, title: schema.issues.title, status: schema.issues.status })
    .from(schema.issues)
    .innerJoin(schema.incidentIssues, eq(schema.incidentIssues.issueId, schema.issues.id))
    .where(eq(schema.incidentIssues.incidentId, incidentId));
  const open = rows.filter((row) => row.status === "open");
  if (open.length === 0) return [];

  const links = await database.query.incidentIssues.findMany({
    where: inArray(
      schema.incidentIssues.issueId,
      open.map((row) => row.id),
    ),
  });
  const latestByIssue = new Map<string, (typeof links)[number]>();
  for (const link of links) {
    const current = latestByIssue.get(link.issueId);
    if (
      !current ||
      link.createdAt > current.createdAt ||
      (link.createdAt.getTime() === current.createdAt.getTime() && link.id > current.id)
    ) {
      latestByIssue.set(link.issueId, link);
    }
  }
  return open
    .filter((row) => latestByIssue.get(row.id)?.incidentId === incidentId)
    .map(({ id, title }) => ({ id, title }));
}
