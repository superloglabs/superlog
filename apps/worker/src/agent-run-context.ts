import {
  type AccessibleGithubInstall,
  db,
  listAccessibleGithubInstallsForProject,
  resolveDefaultAgentRunProvider,
  schema,
} from "@superlog/db";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { listActiveAgentMemories } from "./agent-memory-tools.js";
import { buildAgentRunInstructions } from "./agent-run-instructions.js";
import type {
  AgentRunnerFollowUp,
  AgentRunnerPredecessorIncident,
} from "./agent-runner-backend.js";
import { listInstallationRepositories } from "./infra/github/repositories.js";
import { logger } from "./logger.js";

export type InstalledGithubRepo = {
  id: number;
  fullName: string;
  private: boolean;
  installation: schema.GithubInstallation;
};

type GithubRepoAccess = {
  disabledRepoIds?: number[];
};

export type ScoredGithubRepo = InstalledGithubRepo & { score: number };

export type AgentRunContext = {
  agentRun: schema.AgentRun;
  incident: schema.Incident;
  project: schema.Project;
  automation: {
    autoInvestigateIssuesEnabled: boolean;
    agentRunProvider: string;
    maxRuntimeMinutes: number;
    maxHumanResumeCount: number;
  };
  githubInstalls: AccessibleGithubInstall[];
  linearInstall: schema.LinearInstallation | null;
  customInstructions: string;
  linearTicketPolicy: schema.LinearTicketPolicy;
  linearTicketInstructions: schema.LinearTicketInstruction[];
  linearDefaultTeamId: string | null;
  prPolicy: schema.PrPolicy;
  prBaseBranch: string | null;
  autoMergeFixPrs: schema.AutoMergePolicy;
  autoMergeMethod: schema.AutoMergeMethod;
  issueRows: Array<schema.Issue>;
  memories: Array<schema.AgentMemory>;
  // Set for follow-up runs (trigger != incident): the prior run's distilled
  // context plus the interaction(s) that revived the agent.
  followUp: AgentRunnerFollowUp | null;
  // Closed incidents this one descends from (recurrence/escalation chain via
  // previous_incident_id), newest first, capped at PREDECESSOR_CHAIN_LIMIT.
  predecessors: AgentRunnerPredecessorIncident[];
};

// How many predecessor incidents to summarize into a new run's context. The
// chain can be long for a stubbornly recurring signature; the most recent
// investigations carry the relevant findings.
export const PREDECESSOR_CHAIN_LIMIT = 3;

// Walk the previous_incident_id chain and load a compact summary of each
// predecessor: resolution, agent findings, handoff notes, and PR links.
export async function loadPredecessorIncidents(
  incident: schema.Incident,
): Promise<AgentRunnerPredecessorIncident[]> {
  const out: AgentRunnerPredecessorIncident[] = [];
  const seen = new Set<string>([incident.id]);
  let cursor = incident.previousIncidentId;
  while (cursor && out.length < PREDECESSOR_CHAIN_LIMIT && !seen.has(cursor)) {
    seen.add(cursor);
    const prev = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, cursor),
    });
    if (!prev) break;
    const findingsRun = prev.findingsAgentRunId
      ? await db.query.agentRuns.findFirst({
          where: eq(schema.agentRuns.id, prev.findingsAgentRunId),
          columns: { result: true },
        })
      : null;
    const prs = await db.query.agentPullRequests.findMany({
      where: eq(schema.agentPullRequests.incidentId, prev.id),
      columns: { url: true },
    });
    out.push({
      incidentId: prev.id,
      title: prev.title,
      codename: prev.codename,
      resolvedAt: prev.resolvedAt?.toISOString() ?? null,
      resolvedReasonCode: prev.resolvedReasonCode,
      resolvedReasonText: prev.resolvedReasonText,
      agentSummary: prev.agentSummary,
      rootCauseText: prev.rootCauseText,
      handoffNotes: findingsRun?.result?.handoffNotes ?? null,
      prUrls: prs.map((pr) => pr.url).filter((url): url is string => !!url),
    });
    cursor = prev.previousIncidentId;
  }
  return out;
}

const FOLLOW_UP_TIMELINE_MAX_LINES = 20;

// Pure assembly of the follow-up block from the run row, the latest terminal
// prior run, and the incident timeline. Returns null for ordinary
// incident-triggered runs.
export function buildFollowUpContext(args: {
  trigger: schema.AgentRunTrigger;
  triggerDetail: schema.AgentRunTriggerDetail | null;
  priorRun: schema.AgentRun | null;
  events: Array<Pick<schema.IncidentEvent, "kind" | "summary">>;
}): AgentRunnerFollowUp | null {
  if (args.trigger === "incident") return null;
  const result = args.priorRun?.result ?? null;
  const priorState = args.priorRun?.state;
  return {
    trigger: args.trigger,
    interactions: args.triggerDetail?.interactions ?? [],
    priorRun:
      args.priorRun && result && (priorState === "complete" || priorState === "failed")
        ? {
            state: priorState,
            summary: result.summary,
            rootCause: result.rootCause?.text ?? null,
            handoffNotes: result.handoffNotes ?? null,
            validationSummary: result.pr?.validationSummary ?? null,
            repoFullName: args.priorRun.selectedRepoFullName ?? null,
            prBranch: result.pr?.branchName ?? null,
            prUrl: result.pr?.url ?? null,
          }
        : null,
    timeline: args.events
      .filter((event) => typeof event.summary === "string" && event.summary.length > 0)
      .slice(-FOLLOW_UP_TIMELINE_MAX_LINES)
      .map((event) => `${event.kind}: ${event.summary}`),
  };
}

export async function getProjectAutomation(projectId: string): Promise<{
  autoInvestigateIssuesEnabled: boolean;
  agentRunProvider: string;
  maxRuntimeMinutes: number;
  maxHumanResumeCount: number;
  customInstructions: string;
  agentRunEnabled: boolean;
  linearTicketPolicy: schema.LinearTicketPolicy;
  linearTicketInstructions: schema.LinearTicketInstruction[];
  linearDefaultTeamId: string | null;
  prPolicy: schema.PrPolicy;
  prBaseBranch: string | null;
  autoMergeFixPrs: schema.AutoMergePolicy;
  autoMergeMethod: schema.AutoMergeMethod;
  issueFilterConfig: schema.IssueFilterConfig;
}> {
  const row = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
  });
  return {
    autoInvestigateIssuesEnabled: row?.autoInvestigateIssuesEnabled ?? true,
    agentRunProvider: row?.agentRunProvider ?? resolveDefaultAgentRunProvider(),
    maxRuntimeMinutes: row?.maxRuntimeMinutes ?? 90,
    maxHumanResumeCount: row?.maxHumanResumeCount ?? 3,
    customInstructions: row?.customInstructions ?? "",
    agentRunEnabled: row?.agentRunEnabled ?? true,
    linearTicketPolicy: row?.linearTicketPolicy ?? "on_ready_to_pr",
    linearTicketInstructions: row?.linearTicketInstructions ?? [],
    linearDefaultTeamId: row?.linearDefaultTeamId ?? null,
    prPolicy: row?.prPolicy ?? "on_ready_to_pr",
    prBaseBranch: schema.normalizePrBaseBranch(row?.prBaseBranch),
    autoMergeFixPrs: row?.autoMergeFixPrs ?? "never",
    autoMergeMethod: row?.autoMergeMethod ?? "squash",
    issueFilterConfig: row?.issueFilterConfig ?? schema.EMPTY_ISSUE_FILTER_CONFIG,
  };
}

export async function loadAgentRunContext(
  agentRun: schema.AgentRun,
): Promise<AgentRunContext | null> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, agentRun.incidentId),
  });
  if (!incident) return null;
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });
  if (!project) return null;
  const automation = await getProjectAutomation(project.id);
  const issueIds = await db
    .select({ issueId: schema.incidentIssues.issueId })
    .from(schema.incidentIssues)
    .where(eq(schema.incidentIssues.incidentId, incident.id));
  const issueRows =
    issueIds.length > 0
      ? await db.query.issues.findMany({
          where: inArray(
            schema.issues.id,
            issueIds.map((row) => row.issueId),
          ),
          orderBy: [desc(schema.issues.lastSeen)],
        })
      : [];
  const githubInstalls = await listAccessibleGithubInstallsForProject(project.id);
  const linearInstall =
    (await db.query.linearInstallations.findFirst({
      where: and(
        eq(schema.linearInstallations.projectId, project.id),
        isNull(schema.linearInstallations.revokedAt),
        isNull(schema.linearInstallations.reauthRequiredAt),
      ),
    })) ?? null;
  const orgAgentRow = await db.query.orgAgentSettings.findFirst({
    where: eq(schema.orgAgentSettings.orgId, project.orgId),
  });
  const customInstructions = buildAgentRunInstructions({
    orgInstructions: orgAgentRow?.customInstructions ?? "",
    projectContext: project.projectContext,
    projectInstructions: automation.customInstructions,
  });
  const memories = await listActiveAgentMemories(project.orgId, project.id);
  let followUp: AgentRunnerFollowUp | null = null;
  if (agentRun.trigger !== "incident") {
    const priorRun =
      (await db.query.agentRuns.findFirst({
        where: and(
          eq(schema.agentRuns.incidentId, incident.id),
          ne(schema.agentRuns.id, agentRun.id),
          inArray(schema.agentRuns.state, ["complete", "failed"]),
        ),
        orderBy: [desc(schema.agentRuns.createdAt)],
      })) ?? null;
    const events = await db.query.incidentEvents.findMany({
      where: eq(schema.incidentEvents.incidentId, incident.id),
      orderBy: [asc(schema.incidentEvents.createdAt)],
      columns: { kind: true, summary: true },
    });
    followUp = buildFollowUpContext({
      trigger: agentRun.trigger,
      triggerDetail: agentRun.triggerDetail,
      priorRun,
      events,
    });
  }
  const predecessors = await loadPredecessorIncidents(incident);
  return {
    agentRun,
    incident,
    project,
    automation,
    githubInstalls,
    linearInstall,
    customInstructions,
    linearTicketPolicy: automation.linearTicketPolicy,
    linearTicketInstructions: automation.linearTicketInstructions,
    linearDefaultTeamId: automation.linearDefaultTeamId,
    prPolicy: automation.prPolicy,
    prBaseBranch: automation.prBaseBranch,
    autoMergeFixPrs: automation.autoMergeFixPrs,
    autoMergeMethod: automation.autoMergeMethod,
    issueRows,
    memories,
    followUp,
    predecessors,
  };
}

function extractTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

export function scoreRepos(repos: InstalledGithubRepo[], ctx: AgentRunContext): ScoredGithubRepo[] {
  const serviceTokens = extractTokens(ctx.incident.service);
  const frameTokens = ctx.issueRows.flatMap((issue) =>
    (issue.normalizedFrames ?? []).flatMap((frame) => extractTokens(frame)),
  );
  return repos
    .map((repo) => {
      const repoTokens = extractTokens(repo.fullName);
      let score = 0;
      for (const token of serviceTokens) {
        if (repoTokens.includes(token)) score += 25;
      }
      for (const token of frameTokens) {
        if (repoTokens.includes(token)) score += 4;
      }
      if (
        ctx.incident.service &&
        repo.fullName.toLowerCase().includes(ctx.incident.service.toLowerCase())
      ) {
        score += 35;
      }
      return { ...repo, score };
    })
    .sort((a, b) => b.score - a.score);
}

function dedupeInstalledGithubRepos(repos: InstalledGithubRepo[]): InstalledGithubRepo[] {
  const seen = new Set<string>();
  const deduped: InstalledGithubRepo[] = [];
  for (const repo of repos) {
    if (seen.has(repo.fullName)) continue;
    seen.add(repo.fullName);
    deduped.push(repo);
  }
  return deduped;
}

function normalizeGithubRepoAccess(value: unknown): GithubRepoAccess {
  if (!value || typeof value !== "object") return {};
  const disabledRepoIds = (value as GithubRepoAccess).disabledRepoIds;
  if (!Array.isArray(disabledRepoIds)) return {};
  return {
    disabledRepoIds: [
      ...new Set(disabledRepoIds.filter((id): id is number => Number.isFinite(id) && id > 0)),
    ],
  };
}

function isGithubRepoEnabled(repoAccess: GithubRepoAccess, repoId: number): boolean {
  return !(repoAccess.disabledRepoIds ?? []).includes(repoId);
}

export async function listAccessibleGithubRepositories(
  ctx: AgentRunContext,
): Promise<InstalledGithubRepo[]> {
  const results = await Promise.all(
    ctx.githubInstalls.map(async ({ installation, allowedRepoIds }) => {
      if (!installation.agentEnabled) {
        return { repos: [] as InstalledGithubRepo[], err: null };
      }
      try {
        const repoAccess = normalizeGithubRepoAccess(installation.repoAccess);
        const repos = await listInstallationRepositories(installation.installationId);
        const grantSet = allowedRepoIds === null ? null : new Set(allowedRepoIds);
        return {
          repos: repos
            // Project-scoped (allowedRepoIds=null) sees all repos minus
            // operator-disabled ones. Granted org-scoped installs are
            // additionally limited to the explicit grant set so a project
            // can't reach repos it wasn't given.
            .filter((repo) => isGithubRepoEnabled(repoAccess, repo.id))
            .filter((repo) => grantSet === null || grantSet.has(repo.id))
            .map((repo) => ({ ...repo, installation })),
          err: null,
        };
      } catch (err) {
        logger.warn(
          { err, installationId: installation.installationId },
          "failed to list repositories for GitHub installation",
        );
        return { repos: [] as InstalledGithubRepo[], err };
      }
    }),
  );

  const repos = dedupeInstalledGithubRepos(results.flatMap((result) => result.repos));
  if (repos.length === 0 && results.length > 0 && results.every((result) => result.err)) {
    const firstError = results.find((result) => result.err)?.err;
    throw firstError instanceof Error
      ? firstError
      : new Error("failed to list repositories for all GitHub installations");
  }
  return repos;
}
