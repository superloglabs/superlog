import { db, schema } from "@superlog/db";
import { and, eq, inArray } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { postAgentPrComment } from "../github-app.js";
import { logger } from "../logger.js";
import { type DeliveredLinearTicket, postLinearTicketComment } from "./linear-delivery.js";

export type PullRequestTicketLinkTarget = {
  id: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  url: string;
};

export type LinearPrLinkingDeps = {
  claimGithub(pr: PullRequestTicketLinkTarget, ticket: DeliveredLinearTicket): Promise<boolean>;
  releaseGithub(pr: PullRequestTicketLinkTarget, ticket: DeliveredLinearTicket): Promise<void>;
  postGithubComment(
    pr: PullRequestTicketLinkTarget,
    body: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  claimLinear(pr: PullRequestTicketLinkTarget, ticket: DeliveredLinearTicket): Promise<boolean>;
  releaseLinear(pr: PullRequestTicketLinkTarget, ticket: DeliveredLinearTicket): Promise<void>;
  postLinearComment(
    pr: PullRequestTicketLinkTarget,
    body: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  log(fields: Record<string, unknown>, message: string): void;
};

export function linearTicketPrComment(ticket: DeliveredLinearTicket): string {
  const ticketRef = ticket.url ? `[${ticket.identifier}](${ticket.url})` : ticket.identifier;
  return `Tracking this investigation in Linear: ${ticketRef}`;
}

export function pullRequestLinearComment(pr: PullRequestTicketLinkTarget): string {
  return `Pull request: [${pr.repoFullName}#${pr.prNumber}](${pr.url})`;
}

export function linearTicketSlackReference(ticket: {
  identifier: string;
  url: string | null;
}): string {
  return ticket.url
    ? `Linear: <${ticket.url}|${ticket.identifier}>`
    : `Linear: ${ticket.identifier}`;
}

// The event claim gives each (PR, ticket) pair a durable idempotency key. A
// failed provider call releases its claim so a later sync can retry it.
export async function linkLinearTicketToPullRequestsWithDeps(
  ticket: DeliveredLinearTicket,
  pullRequests: PullRequestTicketLinkTarget[],
  deps: LinearPrLinkingDeps,
): Promise<number> {
  let linked = 0;
  for (const pr of pullRequests) {
    if (await deps.claimGithub(pr, ticket)) {
      const result = await deps.postGithubComment(pr, linearTicketPrComment(ticket));
      if (result.ok) {
        linked += 1;
      } else {
        await deps.releaseGithub(pr, ticket);
        deps.log(
          {
            direction: "linear_to_github",
            agent_pr_id: pr.id,
            repo: pr.repoFullName,
            pr_number: pr.prNumber,
            linear_ticket_id: ticket.ticketId,
            error: result.error,
          },
          "failed to link Linear ticket from PR; released claim for retry",
        );
      }
    }
    if (await deps.claimLinear(pr, ticket)) {
      const result = await deps.postLinearComment(pr, pullRequestLinearComment(pr));
      if (!result.ok) {
        await deps.releaseLinear(pr, ticket);
        deps.log(
          {
            direction: "github_to_linear",
            agent_pr_id: pr.id,
            repo: pr.repoFullName,
            pr_number: pr.prNumber,
            linear_ticket_id: ticket.ticketId,
            error: result.error,
          },
          "failed to link PR from Linear ticket; released claim for retry",
        );
      }
    }
  }
  return linked;
}

function providerEventId(direction: "github" | "linear", ticket: DeliveredLinearTicket): string {
  return `${direction}_ticket_linked:${ticket.ticketId}`;
}

export async function linkLinearTicketToPullRequests(
  ctx: AgentRunContext,
  ticket: DeliveredLinearTicket,
  prUrls: string[],
): Promise<number> {
  if (prUrls.length === 0) return 0;
  const pullRequests = await db
    .select({
      id: schema.agentPullRequests.id,
      installationId: schema.githubInstallations.installationId,
      repoFullName: schema.agentPullRequests.repoFullName,
      prNumber: schema.agentPullRequests.prNumber,
      url: schema.agentPullRequests.url,
    })
    .from(schema.agentPullRequests)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
    )
    .where(
      and(
        eq(schema.agentPullRequests.incidentId, ctx.incident.id),
        inArray(schema.agentPullRequests.url, prUrls),
      ),
    );

  return linkLinearTicketToPullRequestsWithDeps(ticket, pullRequests, {
    async claimGithub(pr, deliveredTicket) {
      const inserted = await db
        .insert(schema.agentPrEvents)
        .values({
          agentPrId: pr.id,
          kind: "linear_ticket_linked",
          summary: `Linked Linear ticket ${deliveredTicket.identifier}`,
          payload: {
            ticketId: deliveredTicket.ticketId,
            identifier: deliveredTicket.identifier,
            url: deliveredTicket.url,
          },
          providerEventId: providerEventId("github", deliveredTicket),
          occurredAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: schema.agentPrEvents.id });
      return inserted.length > 0;
    },
    async releaseGithub(pr, deliveredTicket) {
      await db
        .delete(schema.agentPrEvents)
        .where(
          and(
            eq(schema.agentPrEvents.agentPrId, pr.id),
            eq(schema.agentPrEvents.providerEventId, providerEventId("github", deliveredTicket)),
          ),
        );
    },
    postGithubComment: (pr, body) =>
      postAgentPrComment({
        installationId: pr.installationId,
        repoFullName: pr.repoFullName,
        prNumber: pr.prNumber,
        body,
      }),
    async claimLinear(pr, deliveredTicket) {
      const inserted = await db
        .insert(schema.agentPrEvents)
        .values({
          agentPrId: pr.id,
          kind: "pr_linked_to_linear",
          summary: `Linked PR #${pr.prNumber} from Linear ticket ${deliveredTicket.identifier}`,
          payload: {
            ticketId: deliveredTicket.ticketId,
            identifier: deliveredTicket.identifier,
            ticketUrl: deliveredTicket.url,
            prUrl: pr.url,
          },
          providerEventId: providerEventId("linear", deliveredTicket),
          occurredAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: schema.agentPrEvents.id });
      return inserted.length > 0;
    },
    async releaseLinear(pr, deliveredTicket) {
      await db
        .delete(schema.agentPrEvents)
        .where(
          and(
            eq(schema.agentPrEvents.agentPrId, pr.id),
            eq(schema.agentPrEvents.providerEventId, providerEventId("linear", deliveredTicket)),
          ),
        );
    },
    postLinearComment: (_pr, body) => postLinearTicketComment(ctx, ticket.ticketId, body),
    log: (fields, message) =>
      logger.warn({ scope: "agent_run.linear_pr_link", ...fields }, message),
  });
}
