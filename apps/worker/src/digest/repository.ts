import { type DB, adoptLegacyOrgDigestSettings, schema } from "@superlog/db";
import { and, desc, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import type { DigestCandidate } from "./domain.js";
import type { DigestPolicy } from "./policy.js";

export type ProjectDigestSettings = {
  projectId: string;
  enabled: boolean;
  installationId: string | null;
  channelId: string | null;
  lastRunAt: Date | null;
  runRequestedAt: Date | null;
};

export type DigestRepository = {
  findProjectSettings(projectId: string): Promise<ProjectDigestSettings | undefined>;
  findActiveSlackInstallation(
    installationId: string,
  ): Promise<{ id: string; botAccessToken: string } | undefined>;
  listRunnableProjectSettings(): Promise<ProjectDigestSettings[]>;
  stampLastRun(projectId: string, at: Date): Promise<void>;
  clearRunRequest(projectId: string): Promise<void>;
  gatherCandidates(
    projectId: string,
    policy: Pick<DigestPolicy, "candidateLookbackMs" | "candidateLimit">,
    now: Date,
  ): Promise<DigestCandidate[]>;
};

function toDigestSettings(row: schema.ProjectAutomationSetting): ProjectDigestSettings {
  return {
    projectId: row.projectId,
    enabled: row.digestEnabled ?? false,
    installationId: row.digestSlackInstallationId,
    channelId: row.digestSlackChannelId,
    lastRunAt: row.digestLastRunAt,
    runRequestedAt: row.digestRunRequestedAt,
  };
}

export function createDigestRepository(db: DB): DigestRepository {
  return {
    async findProjectSettings(projectId) {
      await adoptLegacyOrgDigestSettings(db, projectId);
      const row = await db.query.projectAutomationSettings.findFirst({
        where: eq(schema.projectAutomationSettings.projectId, projectId),
      });
      return row ? toDigestSettings(row) : undefined;
    },

    async findActiveSlackInstallation(installationId: string) {
      return db.query.slackInstallations.findFirst({
        where: and(
          eq(schema.slackInstallations.id, installationId),
          isNull(schema.slackInstallations.revokedAt),
        ),
      });
    },

    async listRunnableProjectSettings() {
      await adoptLegacyOrgDigestSettings(db);
      const rows = await db.query.projectAutomationSettings.findMany({
        where: or(
          eq(schema.projectAutomationSettings.digestEnabled, true),
          isNotNull(schema.projectAutomationSettings.digestRunRequestedAt),
        ),
      });
      return rows.map(toDigestSettings);
    },

    async stampLastRun(projectId, at) {
      await db
        .update(schema.projectAutomationSettings)
        .set({ digestLastRunAt: at, digestRunRequestedAt: null, updatedAt: at })
        .where(eq(schema.projectAutomationSettings.projectId, projectId));
    },

    async clearRunRequest(projectId) {
      await db
        .update(schema.projectAutomationSettings)
        .set({ digestRunRequestedAt: null, updatedAt: new Date() })
        .where(eq(schema.projectAutomationSettings.projectId, projectId));
    },

    async gatherCandidates(projectId, policy, now) {
      const project = await db.query.projects.findFirst({
        where: eq(schema.projects.id, projectId),
        columns: { id: true, name: true },
      });
      if (!project) return [];

      const since = new Date(now.getTime() - policy.candidateLookbackMs);
      const prRows = await db
        .select({
          pr: schema.agentPullRequests,
          agentRun: schema.agentRuns,
          incident: schema.incidents,
        })
        .from(schema.agentPullRequests)
        .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.agentPullRequests.agentRunId))
        .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentRuns.incidentId))
        .where(
          and(
            eq(schema.incidents.projectId, projectId),
            eq(schema.agentPullRequests.state, "open"),
            gte(schema.agentPullRequests.createdAt, since),
          ),
        )
        .orderBy(desc(schema.agentPullRequests.createdAt))
        .limit(policy.candidateLimit);

      const candidates: DigestCandidate[] = [];
      for (const row of prRows) {
        const result = row.agentRun.result;
        if (!result || result.state !== "complete") continue;
        if (!result.summary) continue;
        candidates.push({
          agentRunId: row.agentRun.id,
          incidentId: row.incident.id,
          incidentCodename: row.incident.codename || row.incident.id.slice(0, 8),
          incidentTitle: row.incident.title,
          projectName: project.name,
          service: row.incident.service,
          severity: result.severity ?? row.incident.severity ?? null,
          completedAt: row.agentRun.completedAt ?? row.agentRun.updatedAt,
          summary: result.summary,
          rootCause: result.rootCause?.text ?? null,
          estimatedImpact: result.estimatedImpact?.text ?? null,
          pr: {
            id: row.pr.id,
            repoFullName: row.pr.repoFullName,
            number: row.pr.prNumber,
            title: row.pr.title,
            url: row.pr.url,
            branch: row.pr.branchName,
            baseBranch: row.pr.baseBranch,
            openedAt: row.pr.createdAt,
          },
        });
      }
      return candidates;
    },
  };
}
