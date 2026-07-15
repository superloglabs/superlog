import {
  type DB,
  db,
  enqueueIncidentCreated,
  recordInboundInteraction,
  schema,
} from "@superlog/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getProjectAutomation } from "../agent-run-context.js";
import {
  ACTIVE_STATES as AGENT_RUN_ACTIVE_STATES,
  createAgentRunLifecycle,
  isActiveState as isActiveAgentRunState,
} from "../agent-run.js";
import { TERMINAL_STATES as AGENT_RUN_TERMINAL_STATES } from "../agent-runs/domain.js";
import { dispatchAgentRunJob } from "../agent-runs/enqueue.js";
import { investigationGate } from "../billing/investigation-gate.js";
import { usageNotifier } from "../billing/usage-notifier-infra.js";
import { isAutoAgentRunSuppressed } from "../incident-cooldown.js";
import { ensureIncidentForIssue } from "../incident-intake.js";
import {
  postIncidentRootMessage,
  postIncidentThreadMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import {
  canQueueInvestigationForLockedIncident,
  decideIssueArrivalRouting,
} from "./issue-routing.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);
export type IssueTransition = "new" | "recurred" | "escalated";

export type ReopenedIncidentQueueStatus =
  | "queued"
  | "existing_active"
  | "suppressed"
  | "disabled"
  | "no_credits"
  | "incident_closed";

async function queueAgentRunIfNeeded(incident: schema.Incident): Promise<{
  agentRun: schema.AgentRun | null;
  queueStatus: ReopenedIncidentQueueStatus;
}> {
  const automation = await getProjectAutomation(incident.projectId);
  if (!automation.autoInvestigateIssuesEnabled) {
    return { agentRun: null, queueStatus: "disabled" };
  }
  if (!automation.agentRunEnabled) {
    return { agentRun: null, queueStatus: "disabled" };
  }

  if (isAutoAgentRunSuppressed(incident, new Date())) {
    logger.info(
      {
        scope: "agent_run",
        incidentId: incident.id,
        suppressedUntil: incident.autoInvestigateSuppressedUntil?.toISOString(),
      },
      "skipping auto-agent run; agent recently resolved as fixed_in_current_code",
    );
    return { agentRun: null, queueStatus: "suppressed" };
  }

  // If an investigation is already active for this incident, skip the credit
  // gate — it's already running and only needs a context update, not a fresh
  // credit. Gating first would wrongly suppress updates to active runs once
  // credits are exhausted. (The transaction below re-checks under a row lock.)
  const observedActiveRun = await db.query.agentRuns.findFirst({
    where: and(
      eq(schema.agentRuns.incidentId, incident.id),
      inArray(schema.agentRuns.state, [...AGENT_RUN_ACTIVE_STATES]),
    ),
    orderBy: [desc(schema.agentRuns.createdAt)],
  });
  let creditApproved = false;
  const authorizeNewRun = async (): Promise<"incident_closed" | "no_credits" | null> => {
    // Investigation credit gate (Autumn). The org is the Autumn customer. Free
    // orgs that have spent their monthly credits are blocked here; paid plans
    // allow overage so the gate returns true. Fails open if billing is unset or
    // unreachable (see investigation-gate.ts) — we never block on billing errors.
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, incident.projectId),
      columns: { orgId: true },
    });
    if (!project?.orgId || (await investigationGate.canRunInvestigation(project.orgId))) {
      creditApproved = true;
      return null;
    }

    // Persist the block only while the Incident is still open. Resolution uses
    // the same lock, so an external gate response cannot revive stale UI state.
    const marked = await db.transaction(async (tx) => {
      const locked = await tx
        .select({ status: schema.incidents.status })
        .from(schema.incidents)
        .where(eq(schema.incidents.id, incident.id))
        .for("update");
      if (!canQueueInvestigationForLockedIncident(locked[0]?.status ?? null)) return false;
      await tx
        .update(schema.incidents)
        .set({ autoInvestigateBlockedReason: "no_credits" })
        .where(eq(schema.incidents.id, incident.id));
      return true;
    });
    if (!marked) return "incident_closed";

    logger.info(
      { scope: "agent_run", incidentId: incident.id, orgId: project.orgId },
      "skipping auto-agent run; org is out of investigation credits",
    );
    // Blocked because the org hit its investigation cap → fire the upgrade
    // nudge (email + Slack). Deduped per period, so one notice, not one per
    // blocked incident. The per-incident "not started" Slack line is added
    // separately by the caller. Fire-and-forget.
    void usageNotifier?.notify(project.orgId);
    return "no_credits";
  };

  // The optimistic read only decides whether the external credit check can be
  // skipped. The authoritative active-run decision always happens under the
  // Incident lock below. If the observed run finished before that lock, check
  // credits and retry instead of queueing an unmetered successor.
  if (!observedActiveRun) {
    const blocked = await authorizeNewRun();
    if (blocked) return { agentRun: null, queueStatus: blocked };
  }

  type QueueAttempt =
    | { agentRun: schema.AgentRun | null; queueStatus: ReopenedIncidentQueueStatus }
    | { agentRun: null; queueStatus: "needs_credit_check" };
  const attemptQueue = (): Promise<QueueAttempt> =>
    db.transaction(async (tx): Promise<QueueAttempt> => {
      const lockedIncidents = await tx
        .select({ status: schema.incidents.status })
        .from(schema.incidents)
        .where(eq(schema.incidents.id, incident.id))
        .for("update");
      if (!canQueueInvestigationForLockedIncident(lockedIncidents[0]?.status ?? null)) {
        return { agentRun: null, queueStatus: "incident_closed" };
      }

      const existing = await tx.query.agentRuns.findFirst({
        where: and(
          eq(schema.agentRuns.incidentId, incident.id),
          inArray(schema.agentRuns.state, [...AGENT_RUN_ACTIVE_STATES]),
        ),
        orderBy: [desc(schema.agentRuns.createdAt)],
      });
      if (existing) return { agentRun: existing, queueStatus: "existing_active" };
      if (!creditApproved) return { agentRun: null, queueStatus: "needs_credit_check" };

      const queued = await createAgentRunLifecycle(tx as unknown as DB).enqueue({
        incidentId: incident.id,
        runtime: automation.agentRunProvider,
      });
      if (!queued) throw new Error("failed to queue agent run");

      // Clear a stale "out of credits" mark now that a run is queued (e.g. the org
      // upgraded or the monthly limit reset since the last blocked transition).
      if (incident.autoInvestigateBlockedReason !== null) {
        await tx
          .update(schema.incidents)
          .set({ autoInvestigateBlockedReason: null })
          .where(eq(schema.incidents.id, incident.id));
      }

      return { agentRun: queued, queueStatus: "queued" };
    });
  let result = await attemptQueue();
  if (result.queueStatus === "needs_credit_check") {
    const blocked = await authorizeNewRun();
    if (blocked) return { agentRun: null, queueStatus: blocked };
    result = await attemptQueue();
    if (result.queueStatus === "needs_credit_check") {
      throw new Error("credit authorization did not settle investigation queueing");
    }
  }
  if (result.queueStatus === "queued" && result.agentRun) {
    // Post-commit: put the new run on the advance queue now so the
    // investigation starts in seconds. Best-effort — the minute sweep picks
    // it up regardless.
    await dispatchAgentRunJob(result.agentRun.id);
  }
  return result;
}

// Steer the incident's existing investigation with a newly-arrived error
// signature. Routes through the same shared continuation path as human channels
// (Slack/PR comments): resume the durable session, or cold-start a context-
// carrying follow-up when the session is gone. Returns false when nothing was
// actioned (no resumable run, follow-ups disabled, or the follow-up budget is
// spent) so the caller can fall back to the normal investigate path.
async function steerInvestigationWithNewSignature(
  incident: schema.Incident,
  issue: schema.Issue,
  transition: IssueTransition,
): Promise<boolean> {
  const label =
    transition === "new" ? "New" : transition === "escalated" ? "Escalated" : "Recurred";
  const result = await recordInboundInteraction(db, {
    incidentId: incident.id,
    interaction: {
      channel: "issue_joined",
      author: null,
      text: `${label} error signature joined this incident (issue id: ${issue.id}): ${issue.title}. If your existing analysis or open PR already covers this, no new change is needed; if it reveals a code path your fix misses, update that PR in a new turn. Include this Issue in resolve_incident.issueOutcomes when resolving.`,
      occurredAt: new Date().toISOString(),
    },
    dedupeKey: `issue_joined:${issue.id}:${transition}`,
  });
  if (result.outcome === "skipped") return false;
  if (result.outcome === "accepted") {
    await postIncidentThreadMessage(
      incident.id,
      `:repeat: ${label} signal *${issue.title}* folded into this investigation.`,
    );
  }
  return true;
}

export async function handleIssueTransition(
  issue: schema.Issue,
  transition: IssueTransition,
): Promise<void> {
  const { incident, createdIncident, linkedIssue, recurrenceIncident } =
    await ensureIncidentForIssue(issue, transition);
  // Emit the webhook as soon as we know the incident was created, before the
  // (fallible) Slack root post. `createdIncident` is only true on the tick that
  // actually inserts the incident; if a later step in this handler throws and
  // the job retries, `ensureIncidentForIssue` returns createdIncident=false, so
  // emitting after a throwing step would permanently drop the webhook.
  if (createdIncident) {
    await enqueueIncidentCreated(incident.id).catch((err) =>
      logger.error(
        {
          scope: "webhooks.enqueue",
          incident_id: incident.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to enqueue incident.created webhook",
      ),
    );
  }
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, issue.projectId),
  });
  if (createdIncident && project) {
    await postIncidentRootMessage({
      incident,
      projectId: issue.projectId,
      projectName: project.name,
      firstIssue: issue,
    });
    if (recurrenceIncident) {
      await postIncidentThreadMessage(
        incident.id,
        transition === "escalated"
          ? ":rotating_light: An issue under observation tripped its escalation trigger — this incident continues from the earlier investigation, whose findings are available to the new run."
          : issue.kind === "alert"
            ? ":repeat: The alert breached again — this incident continues from the earlier investigation, whose findings are available to the new run."
            : ":repeat: A previously resolved issue recurred — this incident continues from the earlier investigation, whose findings are available to the new run.",
      );
    }
  }

  // If this incident has already been investigated, a new error signature should
  // steer that investigation rather than launch a fresh one (which is what
  // produced duplicate PRs for one root cause). Falls through to the normal
  // investigate path when there's nothing resumable to steer.
  const latestRun = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.incidentId, incident.id),
    orderBy: [desc(schema.agentRuns.createdAt)],
    columns: { state: true },
  });
  const routing = decideIssueArrivalRouting({
    createdIncident,
    suppressed: isAutoAgentRunSuppressed(incident, new Date()),
    latestRunIsTerminal: latestRun
      ? (AGENT_RUN_TERMINAL_STATES as readonly string[]).includes(latestRun.state)
      : false,
  });
  if (
    routing === "steer" &&
    (await steerInvestigationWithNewSignature(incident, issue, transition))
  ) {
    return;
  }

  const { agentRun, queueStatus } = await queueAgentRunIfNeeded(incident);
  if (queueStatus === "queued") {
    await postIncidentThreadMessage(incident.id, ":mag: Investigation queued.");
  } else if (queueStatus === "no_credits") {
    await postIncidentThreadMessage(
      incident.id,
      `:credit_card: Investigation not started — you've gone over the Free plan's monthly investigation limit. Upgrade to pay-as-you-go for more investigations: <${WEB_ORIGIN}/settings?scope=org&section=billing|Manage billing>`,
    );
  }
  if (agentRun && linkedIssue && !createdIncident && isActiveAgentRunState(agentRun.state)) {
    const appended = await agentRunLifecycle.appendContextChangeEvent({
      incidentId: incident.id,
      agentRunId: agentRun.id,
      // Include the issue id: this summary is steered verbatim into the running
      // agent, and resolve_incident.issueOutcomes keys on it. Without the id the
      // agent cannot supply a complete atomic resolution.
      summary: `${transition === "new" ? "New" : "Regressed"} issue joined the incident (issue id: ${issue.id}): ${issue.title}`,
      dedupeKey: `issue:${issue.id}:joined`,
    });
    if (!appended) return;
    await postIncidentThreadMessage(
      incident.id,
      `:information_source: ${transition === "new" ? "New" : "Regressed"} issue joined the incident: *${issue.title}*`,
    );
  }
}
