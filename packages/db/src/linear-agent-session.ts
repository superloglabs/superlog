import { and, eq } from "drizzle-orm";
import type { DB } from "./client.js";
import { createIncidentLifecycle } from "./resolve-incident.js";
import * as schema from "./schema.js";

export type CreateLinearIncidentInput = {
  installation: Pick<schema.LinearInstallation, "id" | "projectId" | "workspaceId">;
  agentSessionId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueUrl: string | null;
  prompt: string;
  runtime: string;
  now?: Date;
};

export async function createIncidentFromLinearSession(
  database: DB,
  input: CreateLinearIncidentInput,
): Promise<{ incident: schema.Incident; agentRun: schema.AgentRun; created: boolean }> {
  const existing = await findExisting(database, input.installation.id, input.agentSessionId);
  if (existing) return { ...existing, created: false };

  const now = input.now ?? new Date();
  const lifecycle = createIncidentLifecycle(database);
  try {
    return await database.transaction(async (tx) => {
      const incident = await lifecycle.createOpenInTx(tx, {
        projectId: input.installation.projectId,
        service: null,
        environment: null,
        title: input.issueTitle?.trim() || input.issueIdentifier || "Linear investigation",
        firstSeen: now,
        lastSeen: now,
      });
      const [agentRun] = await tx
        .insert(schema.agentRuns)
        .values({
          incidentId: incident.id,
          runtime: input.runtime,
          state: "queued",
          trigger: "linear",
          prompt: input.prompt,
        })
        .returning();
      if (!agentRun) throw new Error("failed to queue Linear investigation");

      await tx.insert(schema.linearAgentSessions).values({
        installationId: input.installation.id,
        agentSessionId: input.agentSessionId,
        kind: "incident",
        issueId: input.issueId,
        issueIdentifier: input.issueIdentifier,
        issueTitle: input.issueTitle,
        issueUrl: input.issueUrl,
        incidentId: incident.id,
      });
      // Recording the delegated issue as the run's already-known ticket makes
      // terminal Linear handoff reuse/comment on it instead of filing a copy.
      await tx.insert(schema.agentLinearTickets).values({
        incidentId: incident.id,
        agentRunId: agentRun.id,
        installationId: input.installation.id,
        workspaceId: input.installation.workspaceId,
        ticketId: input.issueId,
        ticketIdentifier: input.issueIdentifier,
        url: input.issueUrl,
        title: input.issueTitle,
        lastSyncedAt: now,
      });
      await tx.insert(schema.incidentEvents).values({
        incidentId: incident.id,
        agentRunId: agentRun.id,
        kind: "agent_run_queued",
        summary: `Investigation delegated from Linear${input.issueIdentifier ? ` issue ${input.issueIdentifier}` : ""}.`,
        detail: {
          linearAgentSessionId: input.agentSessionId,
          linearIssueId: input.issueId,
          linearIssueIdentifier: input.issueIdentifier,
          linearIssueUrl: input.issueUrl,
        },
        dedupeKey: `linear:${input.agentSessionId}`,
        processedAt: now,
      });
      return { incident, agentRun, created: true };
    });
  } catch (err) {
    const code =
      (err as { code?: string; cause?: { code?: string } }).code ??
      (err as { cause?: { code?: string } }).cause?.code;
    if (code !== "23505") throw err;
    const raced = await findExisting(database, input.installation.id, input.agentSessionId);
    if (!raced) throw err;
    return { ...raced, created: false };
  }
}

async function findExisting(
  database: DB,
  installationId: string,
  agentSessionId: string,
): Promise<{ incident: schema.Incident; agentRun: schema.AgentRun } | null> {
  const session = await database.query.linearAgentSessions.findFirst({
    where: and(
      eq(schema.linearAgentSessions.installationId, installationId),
      eq(schema.linearAgentSessions.agentSessionId, agentSessionId),
      eq(schema.linearAgentSessions.kind, "incident"),
    ),
  });
  if (!session?.incidentId) return null;
  const [incident, agentRun] = await Promise.all([
    database.query.incidents.findFirst({ where: eq(schema.incidents.id, session.incidentId) }),
    database.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.incidentId, session.incidentId),
      orderBy: [schema.agentRuns.createdAt],
    }),
  ]);
  return incident && agentRun ? { incident, agentRun } : null;
}
