import {
  type AgentRunResult,
  IllegalIncidentTransitionError,
  db,
  enqueueIncidentMerged,
  isActiveIncidentState,
  schema,
} from "@superlog/db";
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
  fixTargets: string[] | null;
  priorPrState: "open" | "closed" | "merged" | null;
};

/**
 * A merge folds an open source incident into an open survivor. `mergeIncidentsInTx`
 * enforces open→open (see incident-state), but the merge judge is deliberately
 * shown resolved incidents as candidates (loadMergeCandidates) so a fresh
 * lookalike of an already-fixed root cause can be recognized. Guard here so a
 * verdict targeting a non-open incident — or a source that was resolved while the
 * run was in flight — is declined gracefully instead of throwing
 * `IllegalIncidentTransitionError`, which the sync loop reports as `sync_failed`
 * and which permanently kills the investigation.
 */
export function isMergeableIncidentPair(
  source: Pick<schema.Incident, "status">,
  target: Pick<schema.Incident, "status">,
): boolean {
  return isActiveIncidentState(source.status) && isActiveIncidentState(target.status);
}

function changedFilesFromResult(result: unknown): string[] | null {
  const pr = (result as { pr?: { changedFiles?: unknown } | null } | null)?.pr ?? null;
  const files = pr?.changedFiles;
  if (!Array.isArray(files)) return null;
  const cleaned = files.filter((f): f is string => typeof f === "string" && f.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

async function loadMergeCandidates(
  projectId: string,
  excludeIncidentId: string,
): Promise<MergeCandidateRow[]> {
  // Include resolved incidents, not just open ones: if the same root cause was
  // already investigated and fixed (or its PR closed), a new lookalike should be
  // recognized as a duplicate and merged in rather than spawning a fresh PR.
  const incidents = await db.query.incidents.findMany({
    where: and(
      eq(schema.incidents.projectId, projectId),
      inArray(schema.incidents.status, ["open", "resolved"]),
    ),
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
    { summary: string | null; proposedTitle: string | null; fixTargets: string[] | null }
  >();
  for (const inv of agentRuns) {
    if (summaryByIncident.has(inv.incidentId)) continue;
    const r = inv.result as { summary?: string | null; proposedTitle?: string | null } | null;
    summaryByIncident.set(inv.incidentId, {
      summary: r?.summary ?? null,
      proposedTitle: r?.proposedTitle ?? null,
      fixTargets: changedFilesFromResult(inv.result),
    });
  }

  // Latest PR state per candidate incident, so the judge can weigh "this
  // incident already proposed a fix here" — including closed PRs.
  const prs = await db
    .select({
      incidentId: schema.agentPullRequests.incidentId,
      state: schema.agentPullRequests.state,
      createdAt: schema.agentPullRequests.createdAt,
    })
    .from(schema.agentPullRequests)
    .where(
      inArray(
        schema.agentPullRequests.incidentId,
        others.map((i) => i.id),
      ),
    )
    .orderBy(desc(schema.agentPullRequests.createdAt));
  const prStateByIncident = new Map<string, "open" | "closed" | "merged">();
  for (const pr of prs) {
    if (pr.incidentId && !prStateByIncident.has(pr.incidentId)) {
      prStateByIncident.set(pr.incidentId, pr.state as "open" | "closed" | "merged");
    }
  }

  return others.map((incident) => {
    const inv = summaryByIncident.get(incident.id);
    return {
      incident,
      representative: (linkedByIncident.get(incident.id) ?? [])[0] ?? null,
      summary: inv?.summary ?? null,
      proposedTitle: inv?.proposedTitle ?? null,
      fixTargets: inv?.fixTargets ?? null,
      priorPrState: prStateByIncident.get(incident.id) ?? null,
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
    fixTargets: row.fixTargets,
    priorPrState: row.priorPrState,
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
        // The source run just finished; its validated patch isn't a PR yet, so
        // priorPrState is null. Its fixTargets are the files that patch changes.
        fixTargets: changedFilesFromResult(result),
        priorPrState: null,
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

  if (!isMergeableIncidentPair(ctx.incident, targetRow.incident)) {
    logger.info(
      {
        scope: "agent_run.merge",
        agent_run_id: ctx.agentRun.id,
        source_incident_id: ctx.incident.id,
        source_status: ctx.incident.status,
        target_incident_id: targetRow.incident.id,
        target_status: targetRow.incident.status,
      },
      "merge judge chose a non-open incident; completing standalone instead of merging",
    );
    return false;
  }

  try {
    await applyMergeOutcome({
      ctx,
      result,
      target: targetRow.incident,
      evidence: verdict.evidence,
      sessionId,
      runtimeMinutes,
    });
  } catch (err) {
    // Belt-and-suspenders for the TOCTOU race: the source or target can be
    // resolved between candidate load and the merge transaction. The merge is
    // atomic and its state assertion runs before any write, so a rejected merge
    // leaves the run `running` — fall through to standalone completion instead
    // of letting this surface as a `sync_failed`.
    if (err instanceof IllegalIncidentTransitionError) {
      logger.warn(
        {
          scope: "agent_run.merge",
          agent_run_id: ctx.agentRun.id,
          source_incident_id: ctx.incident.id,
          target_incident_id: targetRow.incident.id,
          err: err.message,
        },
        "incident state changed under the merge; completing standalone",
      );
      return false;
    }
    throw err;
  }
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
  // We deliberately do not relay a completed-investigation update for a merge
  // (the run didn't finish investigating a new problem). Instead we emit an
  // incident.updated with change.kind = "merged" so subscribers can follow the
  // dedupe — the source incident folded into the survivor at mergedInto.
  await enqueueIncidentMerged(ctx.incident.id, {
    targetIncidentId: target.id,
    evidence,
  }).catch((err) =>
    logger.error(
      {
        scope: "webhooks.enqueue",
        incident_id: ctx.incident.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to enqueue incident.updated webhook (merged)",
    ),
  );

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
      buttons: [],
      links: [
        { text: "View merge target", url: targetUrl },
        { text: "View this incident", url: sourceUrl },
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
