import { type AgentRunResult, db, schema } from "@superlog/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import { type LinkedIncidentIssue, loadLinkedIncidentIssues } from "../incident-intake.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { type MergeCandidateIncident, analyzeMergeAfterAgentRun } from "../merge-agent-run.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const INCIDENT_GROUPING_CANDIDATE_LIMIT = Number(
  process.env.INCIDENT_GROUPING_CANDIDATE_LIMIT ?? 200,
);
const agentRunLifecycle = createAgentRunLifecycle(db);

type MergeCandidateRow = {
  incident: schema.Incident;
  representative: LinkedIncidentIssue | null;
  summary: string | null;
  proposedTitle: string | null;
};

async function loadMergeCandidates(
  projectId: string,
  excludeIncidentId: string,
): Promise<MergeCandidateRow[]> {
  const incidents = await db.query.incidents.findMany({
    where: and(eq(schema.incidents.projectId, projectId), eq(schema.incidents.status, "open")),
    orderBy: [desc(schema.incidents.lastSeen)],
    limit: INCIDENT_GROUPING_CANDIDATE_LIMIT,
  });
  const others = incidents.filter((i) => i.id !== excludeIncidentId);
  if (others.length === 0) return [];
  const linked = await loadLinkedIncidentIssues(others);
  const linkedByIncident = new Map<string, LinkedIncidentIssue[]>();
  for (const row of linked) {
    const arr = linkedByIncident.get(row.incidentId) ?? [];
    arr.push(row);
    linkedByIncident.set(row.incidentId, arr);
  }
  for (const arr of linkedByIncident.values()) {
    arr.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
  }
  const agentRuns = await db
    .select({
      incidentId: schema.agentRuns.incidentId,
      startedAt: schema.agentRuns.startedAt,
      result: schema.agentRuns.result,
    })
    .from(schema.agentRuns)
    .where(
      inArray(
        schema.agentRuns.incidentId,
        others.map((i) => i.id),
      ),
    )
    .orderBy(desc(schema.agentRuns.startedAt));
  const summaryByIncident = new Map<
    string,
    { summary: string | null; proposedTitle: string | null }
  >();
  for (const inv of agentRuns) {
    if (summaryByIncident.has(inv.incidentId)) continue;
    const r = inv.result as { summary?: string | null; proposedTitle?: string | null } | null;
    summaryByIncident.set(inv.incidentId, {
      summary: r?.summary ?? null,
      proposedTitle: r?.proposedTitle ?? null,
    });
  }
  return others.map((incident) => {
    const inv = summaryByIncident.get(incident.id);
    return {
      incident,
      representative: (linkedByIncident.get(incident.id) ?? [])[0] ?? null,
      summary: inv?.summary ?? null,
      proposedTitle: inv?.proposedTitle ?? null,
    };
  });
}

function buildMergeCandidate(row: MergeCandidateRow): MergeCandidateIncident | null {
  if (!row.representative) return null;
  return {
    id: row.incident.id,
    title: row.representative.title,
    service: row.incident.service,
    firstSeen: row.incident.firstSeen.toISOString(),
    lastSeen: row.incident.lastSeen.toISOString(),
    issueCount: row.incident.issueCount,
    proposedTitle: row.proposedTitle,
    summary: row.summary,
    representative: {
      exceptionType: row.representative.exceptionType,
      message: row.representative.message,
      topFrame: row.representative.topFrame,
      normalizedFrames: row.representative.normalizedFrames ?? [],
    },
  };
}

export async function tryMergeAfterAgentRun(
  ctx: AgentRunContext,
  result: AgentRunResult,
  sessionId: string,
  runtimeMinutes: number,
): Promise<boolean> {
  if (!process.env.ANTHROPIC_API_KEY) return false;
  const sourceRep = ctx.issueRows[0] ?? null;
  if (!sourceRep) return false;
  const candidateRows = await loadMergeCandidates(ctx.project.id, ctx.incident.id);
  const candidates = candidateRows
    .map(buildMergeCandidate)
    .filter((c): c is MergeCandidateIncident => c !== null);
  if (candidates.length === 0) return false;

  let verdict: Awaited<ReturnType<typeof analyzeMergeAfterAgentRun>>;
  try {
    verdict = await analyzeMergeAfterAgentRun({
      projectName: ctx.project.name,
      orgId: ctx.project.orgId,
      projectId: ctx.project.id,
      source: {
        title: sourceRep.title,
        service: ctx.incident.service,
        firstSeen: ctx.incident.firstSeen.toISOString(),
        lastSeen: ctx.incident.lastSeen.toISOString(),
        issueCount: ctx.incident.issueCount,
        proposedTitle: result.proposedTitle ?? null,
        summary: result.summary,
        representative: {
          exceptionType: sourceRep.exceptionType,
          message: sourceRep.message,
          topFrame: sourceRep.topFrame,
          normalizedFrames: sourceRep.normalizedFrames ?? [],
        },
      },
      candidates,
    });
  } catch (err) {
    logger.warn(
      {
        scope: "agent_run.merge",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "merge analysis failed; proceeding with standalone completion",
    );
    return false;
  }
  if (verdict.decision !== "merge") return false;

  const targetRow = candidateRows.find((r) => r.incident.id === verdict.targetIncidentId);
  if (!targetRow) return false;

  await applyMergeOutcome({
    ctx,
    result,
    target: targetRow.incident,
    evidence: verdict.evidence,
    sessionId,
    runtimeMinutes,
  });
  return true;
}

async function applyMergeOutcome(opts: {
  ctx: AgentRunContext;
  result: AgentRunResult;
  target: schema.Incident;
  evidence: string;
  sessionId: string;
  runtimeMinutes: number;
}): Promise<void> {
  const { ctx, result, target, evidence, sessionId, runtimeMinutes } = opts;

  await agentRunLifecycle.completeViaMerge({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    result,
    sourceIncident: ctx.incident,
    targetIncident: target,
    evidence,
  });
  // No webhook here: a merge means we recognized this incident as a duplicate
  // of another, not that we finished investigating a new problem. Webhook
  // subscribers care about completed agentRuns with findings.

  logger.info(
    {
      scope: "agent_run.merge",
      agent_run_id: ctx.agentRun.id,
      source_incident_id: ctx.incident.id,
      source_codename: ctx.incident.codename,
      target_incident_id: target.id,
      target_codename: target.codename,
      session_id: sessionId,
      runtime_minutes: runtimeMinutes,
      evidence,
    },
    "agent run merged into existing incident",
  );

  const targetUrl = `${WEB_ORIGIN}/incidents/${target.id}`;
  const sourceUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  const targetLabel = target.codename || target.title;
  const sourceLabel = ctx.incident.codename || ctx.incident.title;

  await updateIncidentMainMessage(
    ctx.incident.id,
    `:link: Merged into ${targetLabel}: ${ctx.incident.title}`,
    incidentBlocks({
      emoji: "link",
      status: `Merged into ${targetLabel}`,
      title: ctx.incident.title,
      tagline: evidence,
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [
        { text: "View merge target", url: targetUrl, actionId: "view_merge_target" },
        { text: "View this incident", url: sourceUrl, actionId: "view_incident" },
      ],
      incidentId: ctx.incident.id,
    }),
  );
  await postIncidentThreadMessage(
    ctx.incident.id,
    `:link: This incident was merged into *${targetLabel}* — same root cause: ${evidence}\n${targetUrl}`,
  );
  await postIncidentThreadMessage(
    target.id,
    `:link: *${sourceLabel}* was merged into this incident.\n*Investigation summary:* ${result.summary}\n*Shared root cause:* ${evidence}\n${sourceUrl}`,
  );
}
