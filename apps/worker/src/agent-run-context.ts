import {
  type AccessibleGithubInstall,
  DEFAULT_AGENT_RUN_PROVIDER,
  db,
  listAccessibleGithubInstallsForProject,
  schema,
} from "@superlog/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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
  prPolicy: schema.PrPolicy;
  autoMergeFixPrs: schema.AutoMergePolicy;
  autoMergeMethod: schema.AutoMergeMethod;
  issueRows: Array<schema.Issue>;
};

export async function getProjectAutomation(projectId: string): Promise<{
  autoInvestigateIssuesEnabled: boolean;
  agentRunProvider: string;
  maxRuntimeMinutes: number;
  maxHumanResumeCount: number;
  customInstructions: string;
  agentRunEnabled: boolean;
  linearTicketPolicy: schema.LinearTicketPolicy;
  linearTicketInstructions: schema.LinearTicketInstruction[];
  prPolicy: schema.PrPolicy;
  autoMergeFixPrs: schema.AutoMergePolicy;
  autoMergeMethod: schema.AutoMergeMethod;
  issueFilterConfig: schema.IssueFilterConfig;
}> {
  const row = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
  });
  return {
    autoInvestigateIssuesEnabled: row?.autoInvestigateIssuesEnabled ?? true,
    agentRunProvider: row?.agentRunProvider ?? DEFAULT_AGENT_RUN_PROVIDER,
    maxRuntimeMinutes: row?.maxRuntimeMinutes ?? 90,
    maxHumanResumeCount: row?.maxHumanResumeCount ?? 3,
    customInstructions: row?.customInstructions ?? "",
    agentRunEnabled: row?.agentRunEnabled ?? true,
    linearTicketPolicy: row?.linearTicketPolicy ?? "on_ready_to_pr",
    linearTicketInstructions: row?.linearTicketInstructions ?? [],
    prPolicy: row?.prPolicy ?? "on_ready_to_pr",
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
  const orgInstructions = (orgAgentRow?.customInstructions ?? "").trim();
  const projectInstructions = automation.customInstructions.trim();
  const customInstructions = [orgInstructions, projectInstructions]
    .filter((s) => s.length > 0)
    .join("\n\n");
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
    prPolicy: automation.prPolicy,
    autoMergeFixPrs: automation.autoMergeFixPrs,
    autoMergeMethod: automation.autoMergeMethod,
    issueRows,
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
