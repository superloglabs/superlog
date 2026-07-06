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
import { investigationGate } from "../billing/investigation-gate.js";
import { usageNotifier } from "../billing/usage-notifier-infra.js";
import { isAutoAgentRunSuppressed } from "../incident-cooldown.js";
import { ensureIncidentForIssue } from "../incident-intake.js";
import {
  postIncidentRootMessage,
  postIncidentThreadMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { decideIssueArrivalRouting } from "./issue-routing.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);
export type IssueTransition = "new" | "recurred" | "escalated";

export type ReopenedIncidentQueueStatus =
  | "queued"
  | "existing_active"
  | "suppressed"
  | "disabled"
  | "no_credits";

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
  const activeRun = await db.query.agentRuns.findFirst({
    where: and(
      eq(schema.agentRuns.incidentId, incident.id),
      inArray(schema.agentRuns.state, [...AGENT_RUN_ACTIVE_STATES]),
    ),
    orderBy: [desc(schema.agentRuns.createdAt)],
  });
  if (activeRun) return { agentRun: activeRun, queueStatus: "existing_active" };

  // Investigation credit gate (Autumn). The org is the Autumn customer. Free
  // orgs that have spent their monthly credits are blocked here; paid plans
  // allow overage so the gate returns true. Fails open if billing is unset or
  // unreachable (see investigation-gate.ts) — we never block on billing errors.
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
    columns: { orgId: true },
  });
  if (project?.orgId && !(await investigationGate.canRunInvestigation(project.orgId))) {
    logger.info(
      { scope: "agent_run", incidentId: incident.id, orgId: project.orgId },
      "skipping auto-agent run; org is out of investigation credits",
    );
    // Blocked because the org hit its investigation cap → fire the upgrade
    // nudge (email + Slack). Deduped per period, so one notice, not one per
    // blocked incident. The per-incident "not started" Slack line is added
    // separately by the caller. Fire-and-forget.
    void usageNotifier?.notify(project.orgId);
    return { agentRun: null, queueStatus: "no_credits" };
  }

  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.incidents.id })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, incident.id))
      .for("update");

    const existing = await tx.query.agentRuns.findFirst({
      where: and(
        eq(schema.agentRuns.incidentId, incident.id),
        inArray(schema.agentRuns.state, [...AGENT_RUN_ACTIVE_STATES]),
      ),
      orderBy: [desc(schema.agentRuns.createdAt)],
    });
    if (existing) return { agentRun: existing, queueStatus: "existing_active" };

    const queued = await createAgentRunLifecycle(tx as unknown as DB).enqueue({
      incidentId: incident.id,
      runtime: automation.agentRunProvider,
    });
    if (!queued) throw new Error("failed to queue agent run");

    return { agentRun: queued, queueStatus: "queued" };
  });
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
      text: `${label} error signature joined this incident: ${issue.title}. If your existing analysis or open PR already covers this, no new change is needed; if it reveals a code path your fix misses, extend the existing PR rather than opening another.`,
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
    await agentRunLifecycle.appendContextChangeEvent({
      agentRunId: agentRun.id,
      summary: `${transition === "new" ? "New" : "Regressed"} issue joined the incident: ${issue.title}`,
      dedupeKey: `issue:${issue.id}:joined`,
    });
    await postIncidentThreadMessage(
      incident.id,
      `:information_source: ${transition === "new" ? "New" : "Regressed"} issue joined the incident: *${issue.title}*`,
    );
  }
}
