import { type DB, schema } from "@superlog/db";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { DigestCandidate } from "./domain.js";
import type { DigestPolicy } from "./policy.js";

export type DigestRepository = ReturnType<typeof createDigestRepository>;

export function createDigestRepository(db: DB) {
  return {
    async findOrgSettings(orgId: string) {
      return db.query.orgAgentSettings.findFirst({
        where: eq(schema.orgAgentSettings.orgId, orgId),
      });
    },

    async findActiveSlackInstallation(installationId: string) {
      return db.query.slackInstallations.findFirst({
        where: and(
          eq(schema.slackInstallations.id, installationId),
          isNull(schema.slackInstallations.revokedAt),
        ),
      });
    },

    async listEnabledDigestSettings() {
      return db.query.orgAgentSettings.findMany({
        where: eq(schema.orgAgentSettings.digestEnabled, true),
      });
    },

    async stampLastRun(orgId: string, at: Date): Promise<void> {
      await db
        .update(schema.orgAgentSettings)
        .set({ digestLastRunAt: at, updatedAt: at })
        .where(eq(schema.orgAgentSettings.orgId, orgId));
    },

    async gatherCandidates(
      orgId: string,
      policy: Pick<DigestPolicy, "candidateLookbackMs" | "candidateLimit">,
      now: Date,
    ): Promise<DigestCandidate[]> {
      const projects = await db.query.projects.findMany({
        where: eq(schema.projects.orgId, orgId),
        columns: { id: true, name: true },
      });
      if (projects.length === 0) return [];
      const projectIds = projects.map((p) => p.id);
      const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

      const since = new Date(now.getTime() - policy.candidateLookbackMs);
      const prRows = await db
        .select({
          pr: schema.agentPullRequests,
          agentRun: schema.agentRuns,
          incident: schema.incidents,
        })
        .from(schema.agentPullRequests)
        .innerJoin(
          schema.agentRuns,
          eq(schema.agentRuns.id, schema.agentPullRequests.agentRunId),
        )
        .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentRuns.incidentId))
        .where(
          and(
            inArray(schema.incidents.projectId, projectIds),
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
          projectName: projectNameById.get(row.incident.projectId) ?? "(unknown)",
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
