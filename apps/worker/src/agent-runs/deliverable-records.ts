import { db, schema } from "@superlog/db";
import type { AgentRunContext } from "../agent-run-context.js";
import { recordPrCreatedMetric } from "../pr-metrics.js";

export async function recordFiledLinearTicket(
  ctx: AgentRunContext,
  ticket: schema.AgentRunLinearTicket | null | undefined,
  opts: { identifier?: string | null } = {},
): Promise<void> {
  if (!ticket?.id) return;
  if (!ctx.linearInstall) return;
  const now = new Date();
  const inserted = await db
    .insert(schema.agentLinearTickets)
    .values({
      incidentId: ctx.incident.id,
      agentRunId: ctx.agentRun.id,
      installationId: ctx.linearInstall.id,
      workspaceId: ctx.linearInstall.workspaceId,
      ticketId: ticket.id,
      ticketIdentifier: opts.identifier ?? null,
      url: ticket.url ?? null,
      lastSyncedAt: now,
    })
    .onConflictDoNothing({
      target: [schema.agentLinearTickets.workspaceId, schema.agentLinearTickets.ticketId],
    })
    .returning({ id: schema.agentLinearTickets.id });
  const row = inserted[0];
  if (!row) return;
  await db
    .insert(schema.agentLinearTicketEvents)
    .values({
      agentLinearTicketId: row.id,
      kind: "ticket_filed",
      summary: `Filed Linear ticket ${opts.identifier ?? ticket.id}`,
      payload: { url: ticket.url ?? null, createdByAgent: ticket.createdByAgent },
      providerEventId: `ticket_filed:${ctx.linearInstall.workspaceId}:${ticket.id}`,
      occurredAt: now,
    })
    .onConflictDoNothing();
}

export async function recordOpenedAgentPullRequest(opts: {
  incidentId: string;
  agentRunId: string;
  installationRowId: string;
  repoFullName: string;
  prNumber: number;
  prNodeId: string;
  url: string;
  branchName: string;
  baseBranch: string;
  headSha: string;
  title: string;
  authorLogin: string | null;
  authorGithubId: number | null;
  authorAvatarUrl: string | null;
}): Promise<void> {
  const now = new Date();
  const inserted = await db
    .insert(schema.agentPullRequests)
    .values({
      incidentId: opts.incidentId,
      agentRunId: opts.agentRunId,
      installationId: opts.installationRowId,
      repoFullName: opts.repoFullName,
      prNumber: opts.prNumber,
      prNodeId: opts.prNodeId,
      url: opts.url,
      branchName: opts.branchName,
      baseBranch: opts.baseBranch,
      headSha: opts.headSha,
      state: "open",
      title: opts.title,
      lastSyncedAt: now,
    })
    .onConflictDoNothing({
      target: [schema.agentPullRequests.repoFullName, schema.agentPullRequests.prNumber],
    })
    .returning({ id: schema.agentPullRequests.id });
  const row = inserted[0];
  if (!row) return;
  await db
    .insert(schema.agentPrEvents)
    .values({
      agentPrId: row.id,
      kind: "pr_opened",
      summary: `Opened PR #${opts.prNumber}`,
      actorLogin: opts.authorLogin,
      actorGithubId: opts.authorGithubId,
      actorAvatarUrl: opts.authorAvatarUrl,
      payload: {
        url: opts.url,
        branch: opts.branchName,
        base: opts.baseBranch,
        headSha: opts.headSha,
      },
      providerEventId: `pr_opened:${opts.repoFullName}#${opts.prNumber}`,
      occurredAt: now,
    })
    .onConflictDoNothing();
  // Only reached when the PR row was newly inserted (see `if (!row) return`
  // above), so retries / re-deliveries don't double-count.
  await recordPrCreatedMetric({
    id: row.id,
    incidentId: opts.incidentId,
    agentRunId: opts.agentRunId,
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    url: opts.url,
  });
}
