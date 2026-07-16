// Deterministic Linear ticket delivery. The platform — not the agent — files
// exactly one ticket for each investigation handoff. A retry of the same
// terminal or first-PR boundary reuses that run's ticket, while a later
// run always creates a new one. Delivery is best-effort: any failure is logged
// and returns null, never blocking the investigation state transition.

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
import { buildIncidentUrl } from "../incident-route.js";
import { logger } from "../logger.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

// Marker line embedded in every ticket description for provider-side
// correlation and recovery. Delivery retries use the locally recorded ticket
// as their source of truth, with exact-marker provider lookup only when the
// provider mutation succeeded before the local record committed.
export function investigationMarker(incidentId: string, agentRunId: string): string {
  return `superlog_incident_id=${incidentId} superlog_agent_run_id=${agentRunId}`;
}

export type DeliveredLinearTicket = {
  // Linear's issue UUID — what agent_linear_tickets.ticket_id stores and what
  // webhook payloads match on (payload.data.id).
  ticketId: string;
  // Human identifier for display, e.g. ENG-42.
  identifier: string;
  url: string | null;
  // True when this delivery created the ticket (vs reusing an existing one).
  created: boolean;
};

export function ticketDescription(
  args: {
    incidentId: string;
    agentRunId: string;
    incidentTitle: string;
    orgSlug: string;
    projectSlug: string;
  },
  result: AgentRunResult,
  prUrls: string[],
): string {
  const lines: string[] = [result.summary];
  if (result.rootCause?.text) {
    lines.push("", "## Root cause", result.rootCause.text);
  }
  if (result.estimatedImpact?.text) {
    lines.push("", "## Impact", result.estimatedImpact.text);
  }
  if (result.severity) lines.push("", `Severity: ${result.severity}`);
  if (prUrls.length > 0) {
    lines.push("", prUrls.length === 1 ? "Proposed fix:" : "Proposed fixes:");
    lines.push(...prUrls.map((url) => `- ${url}`));
  }
  lines.push(
    "",
    `[Incident on Superlog](${buildIncidentUrl(WEB_ORIGIN, {
      orgSlug: args.orgSlug,
      projectSlug: args.projectSlug,
      incidentId: args.incidentId,
    })})`,
  );
  lines.push("", investigationMarker(args.incidentId, args.agentRunId));
  return lines.join("\n");
}

export function isRevokedTokenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid_grant|revoked|unauthorized|401/i.test(msg);
}

function isLinearIssueUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Should this completion produce/refresh a ticket at all?
export function linearDeliveryAllowed(args: { hasInstall: boolean }): boolean {
  return args.hasInstall;
}

export type LinearDeliveryDeps = {
  findKnownTicket(): Promise<{
    ticketId: string;
    identifier: string | null;
    url: string | null;
  } | null>;
  searchIssues(term: string): Promise<LinearIssueRef[]>;
  createIssue(args: {
    teamId: string;
    title: string;
    description: string;
  }): Promise<LinearIssueRef>;
  listTeams(): Promise<LinearTeam[]>;
  markNeedsReauth(reason: string): Promise<void>;
  log(level: "info" | "warn", fields: Record<string, unknown>, msg: string): void;
};

// Core delivery: reuse a ticket already recorded/found for this exact run,
// otherwise create under the configured (or first) team.
export async function deliverLinearTicketWithDeps(
  args: {
    incidentId: string;
    agentRunId: string;
    incidentTitle: string;
    orgSlug: string;
    projectSlug: string;
    hasInstall: boolean;
    defaultTeamId: string | null;
    prUrls: string[];
  },
  result: AgentRunResult,
  deps: LinearDeliveryDeps,
): Promise<DeliveredLinearTicket | null> {
  if (!linearDeliveryAllowed({ hasInstall: args.hasInstall })) {
    return null;
  }
  try {
    const known = await deps.findKnownTicket();
    if (known) {
      if (!isLinearIssueUuid(known.ticketId)) {
        const identifier = known.identifier ?? known.ticketId;
        const resolved = (await deps.searchIssues(identifier)).find(
          (issue) => issue.identifier === identifier,
        );
        if (resolved) {
          return {
            ticketId: resolved.id,
            identifier: resolved.identifier,
            url: resolved.url ?? known.url,
            created: false,
          };
        }
      }
      return {
        ticketId: known.ticketId,
        identifier: known.identifier ?? known.ticketId,
        url: known.url,
        created: false,
      };
    }

    const marker = investigationMarker(args.incidentId, args.agentRunId);
    const recovered = (await deps.searchIssues(marker)).find((issue) =>
      issue.description?.includes(marker),
    );
    if (recovered) {
      return {
        ticketId: recovered.id,
        identifier: recovered.identifier,
        url: recovered.url,
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
        {
          incidentId: args.incidentId,
          agentRunId: args.agentRunId,
          incidentTitle: args.incidentTitle,
          orgSlug: args.orgSlug,
          projectSlug: args.projectSlug,
        },
        result,
        args.prUrls,
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

export async function postLinearTicketComment(
  ctx: AgentRunContext,
  ticketId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const install = ctx.linearInstall;
  if (!install) return { ok: false, error: "Linear is not connected" };
  try {
    await createLinearComment({
      accessToken: await resolveAccessToken(ctx),
      issueId: ticketId,
      body,
    });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (isRevokedTokenError(err)) {
      await markLinearInstallationNeedsReauth(install.id, `agent PR linking: ${error}`).catch(
        () => undefined,
      );
    }
    return { ok: false, error };
  }
}

export async function deliverLinearTicket(
  ctx: AgentRunContext,
  result: AgentRunResult,
  opts: { prUrls: string[] },
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
      agentRunId: ctx.agentRun.id,
      incidentTitle: ctx.incident.title,
      orgSlug: ctx.org.slug,
      projectSlug: ctx.project.slug,
      hasInstall: !!install,
      defaultTeamId: ctx.linearDefaultTeamId,
      prUrls: opts.prUrls,
    },
    result,
    {
      async findKnownTicket() {
        const row = await db.query.agentLinearTickets.findFirst({
          where: eq(schema.agentLinearTickets.agentRunId, ctx.agentRun.id),
        });
        return row
          ? { ticketId: row.ticketId, identifier: row.ticketIdentifier, url: row.url }
          : null;
      },
      searchIssues: async (term) => searchLinearIssues(await resolveTokenOnce(), term),
      createIssue: async (args) =>
        createLinearIssue({ accessToken: await resolveTokenOnce(), ...args }),
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
