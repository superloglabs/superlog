// Deterministic Linear ticket delivery. The platform — not the agent — files
// or updates the incident's Linear ticket from the completed run's findings,
// so the recorded ticket id/url always refer to a ticket that actually
// exists. Delivery is best-effort: any failure is logged and returns null,
// never blocking run completion.

import {
  type AgentRunResult,
  type LinearIssueRef,
  type LinearTeam,
  createLinearComment,
  createLinearIssue,
  db,
  ensureFreshLinearToken,
  listLinearTeams,
  markLinearInstallationNeedsReauth,
  schema,
  searchLinearIssues,
} from "@superlog/db";
import { eq } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { logger } from "../logger.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

// Marker line embedded in every ticket description; dedupe searches for it.
// Kept identical to the convention agent-filed tickets used, so historical
// tickets keep deduping.
export function incidentMarker(incidentId: string): string {
  return `superlog_incident_id=${incidentId}`;
}

export type DeliveredLinearTicket = {
  // Linear's issue UUID — what agent_linear_tickets.ticket_id stores and what
  // webhook payloads match on (payload.data.id).
  ticketId: string;
  // Human identifier for display, e.g. ENG-42.
  identifier: string;
  url: string | null;
  // True when this delivery created the ticket (vs commented on an existing one).
  created: boolean;
};

export function ticketDescription(
  args: { incidentId: string; incidentTitle: string },
  result: AgentRunResult,
  prUrl: string | null,
): string {
  const lines: string[] = [result.summary];
  if (result.rootCause?.text) {
    lines.push("", "## Root cause", result.rootCause.text);
  }
  if (result.estimatedImpact?.text) {
    lines.push("", "## Impact", result.estimatedImpact.text);
  }
  if (result.severity) lines.push("", `Severity: ${result.severity}`);
  if (result.recommendedAction) {
    lines.push("", "## Recommended action", result.recommendedAction);
  }
  if (prUrl) lines.push("", `Proposed fix: ${prUrl}`);
  lines.push("", `[Incident on Superlog](${WEB_ORIGIN}/incidents/${args.incidentId})`);
  lines.push("", incidentMarker(args.incidentId));
  return lines.join("\n");
}

function followUpComment(result: AgentRunResult, prUrl: string | null): string {
  const lines: string[] = ["New findings from the latest investigation run:", "", result.summary];
  if (result.rootCause?.text) lines.push("", result.rootCause.text);
  if (prUrl) lines.push("", `Proposed fix: ${prUrl}`);
  return lines.join("\n");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRevokedTokenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid_grant|revoked|unauthorized|401/i.test(msg);
}

// Should this completion produce/refresh a ticket at all?
export function linearDeliveryAllowed(
  args: {
    hasInstall: boolean;
    policy: schema.LinearTicketPolicy;
    prUrl: string | null;
  },
): boolean {
  if (!args.hasInstall) return false;
  if (args.policy === "never") return false;
  if (args.policy === "on_ready_to_pr" && !args.prUrl) return false;
  return true;
}

export type LinearDeliveryDeps = {
  findKnownTicket(): Promise<{
    ticketId: string;
    identifier: string | null;
    url: string | null;
  } | null>;
  searchIssues(term: string): Promise<LinearIssueRef[]>;
  createIssue(args: { teamId: string; title: string; description: string }): Promise<LinearIssueRef>;
  createComment(args: { issueId: string; body: string }): Promise<void>;
  listTeams(): Promise<LinearTeam[]>;
  markNeedsReauth(reason: string): Promise<void>;
  log(level: "info" | "warn", fields: Record<string, unknown>, msg: string): void;
};

// Core delivery: comment on the incident's known ticket, else dedupe by
// marker search, else create under the configured (or first) team.
export async function deliverLinearTicketWithDeps(
  args: {
    incidentId: string;
    incidentTitle: string;
    policy: schema.LinearTicketPolicy;
    hasInstall: boolean;
    defaultTeamId: string | null;
    prUrl: string | null;
  },
  result: AgentRunResult,
  deps: LinearDeliveryDeps,
): Promise<DeliveredLinearTicket | null> {
  if (!linearDeliveryAllowed({ hasInstall: args.hasInstall, policy: args.policy, prUrl: args.prUrl })) {
    return null;
  }
  try {
    const known = await deps.findKnownTicket();
    if (known) {
      // New rows store the Linear issue UUID and can be commented directly;
      // legacy agent-filed rows may hold the human identifier instead, which
      // needs a search to resolve to the UUID.
      if (UUID_RE.test(known.ticketId)) {
        await deps.createComment({
          issueId: known.ticketId,
          body: followUpComment(result, args.prUrl),
        });
        return {
          ticketId: known.ticketId,
          identifier: known.identifier ?? known.ticketId,
          url: known.url,
          created: false,
        };
      }
      const [found] = await deps.searchIssues(known.ticketId);
      if (found) {
        await deps.createComment({ issueId: found.id, body: followUpComment(result, args.prUrl) });
        return {
          ticketId: found.id,
          identifier: found.identifier,
          url: known.url ?? found.url,
          created: false,
        };
      }
    }

    const [existing] = await deps.searchIssues(incidentMarker(args.incidentId));
    if (existing) {
      await deps.createComment({ issueId: existing.id, body: followUpComment(result, args.prUrl) });
      return {
        ticketId: existing.id,
        identifier: existing.identifier,
        url: existing.url,
        created: false,
      };
    }

    let teamId = args.defaultTeamId;
    if (!teamId) {
      const teams = await deps.listTeams();
      teamId = teams[0]?.id ?? null;
      if (!teamId) {
        deps.log("warn", {}, "linear workspace has no teams; skipping ticket delivery");
        return null;
      }
      deps.log(
        "info",
        { team_id: teamId },
        "no linearDefaultTeamId configured; using the workspace's first team",
      );
    }
    const issue = await deps.createIssue({
      teamId,
      title: args.incidentTitle,
      description: ticketDescription(
        { incidentId: args.incidentId, incidentTitle: args.incidentTitle },
        result,
        args.prUrl,
      ),
    });
    return { ticketId: issue.id, identifier: issue.identifier, url: issue.url, created: true };
  } catch (err) {
    if (isRevokedTokenError(err)) {
      await deps
        .markNeedsReauth(
          `agent ticket delivery: ${err instanceof Error ? err.message : String(err)}`,
        )
        .catch(() => undefined);
    }
    deps.log(
      "warn",
      { err: err instanceof Error ? err.message : String(err) },
      "linear ticket delivery failed; continuing without a ticket",
    );
    return null;
  }
}

async function resolveAccessToken(ctx: AgentRunContext): Promise<string> {
  const install = ctx.linearInstall;
  if (!install) throw new Error("no linear installation");
  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  if (clientId && clientSecret) {
    const fresh = await ensureFreshLinearToken({
      installationId: install.id,
      clientId,
      clientSecret,
    });
    return fresh.accessToken;
  }
  // No OAuth client creds in this process: use the stored token as-is. It may
  // be expired, in which case delivery fails best-effort and is logged.
  return install.accessToken;
}

export async function deliverLinearTicket(
  ctx: AgentRunContext,
  result: AgentRunResult,
  opts: { prUrl: string | null },
): Promise<DeliveredLinearTicket | null> {
  // The run may have retitled the incident (applyAgentRunResult) after ctx
  // was loaded; reload so the ticket carries the current title in every
  // caller path, not just the ones that refresh ctx themselves. Best-effort
  // like the rest of delivery: a failed reload falls back to the stale title
  // rather than blocking completion.
  try {
    const refreshed = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, ctx.incident.id),
    });
    if (refreshed) ctx.incident = refreshed;
  } catch (err) {
    logger.warn(
      {
        scope: "agent_run.linear_delivery",
        incident_id: ctx.incident.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "incident refresh before ticket delivery failed; using the loaded title",
    );
  }
  const install = ctx.linearInstall;
  const logFields = {
    scope: "agent_run.linear_delivery",
    agent_run_id: ctx.agentRun.id,
    incident_id: ctx.incident.id,
    installation_id: install?.id ?? null,
  };
  let accessToken: string | null = null;
  return deliverLinearTicketWithDeps(
    {
      incidentId: ctx.incident.id,
      incidentTitle: ctx.incident.title,
      policy: ctx.linearTicketPolicy,
      hasInstall: !!install,
      defaultTeamId: ctx.linearDefaultTeamId,
      prUrl: opts.prUrl,
    },
    result,
    {
      async findKnownTicket() {
        const row = await db.query.agentLinearTickets.findFirst({
          where: eq(schema.agentLinearTickets.incidentId, ctx.incident.id),
        });
        return row
          ? { ticketId: row.ticketId, identifier: row.ticketIdentifier, url: row.url }
          : null;
      },
      searchIssues: async (term) => searchLinearIssues(await resolveTokenOnce(), term),
      createIssue: async (args) => createLinearIssue({ accessToken: await resolveTokenOnce(), ...args }),
      createComment: async (args) => createLinearComment({ accessToken: await resolveTokenOnce(), ...args }),
      listTeams: async () => listLinearTeams(await resolveTokenOnce()),
      markNeedsReauth: async (reason) => {
        if (install) await markLinearInstallationNeedsReauth(install.id, reason);
      },
      log: (level, fields, msg) => logger[level]({ ...logFields, ...fields }, msg),
    },
  );

  async function resolveTokenOnce(): Promise<string> {
    accessToken ??= await resolveAccessToken(ctx);
    return accessToken;
  }
}
