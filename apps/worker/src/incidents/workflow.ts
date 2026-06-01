import { type DB, db, schema } from "@superlog/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getProjectAutomation } from "../agent-run-context.js";
import { investigationGate } from "../billing/investigation-gate.js";
import {
  ACTIVE_STATES as AGENT_RUN_ACTIVE_STATES,
  createAgentRunLifecycle,
  isActiveState as isActiveAgentRunState,
} from "../agent-run.js";
import { isAutoAgentRunSuppressed } from "../incident-cooldown.js";
import { ensureIncidentForIssue } from "../incident-intake.js";
import { buildReopenedIncidentSlackUpdate } from "../incident-slack.js";
import {
  incidentBlocks,
  postIncidentRootMessage,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);
export type IssueTransition = "new" | "regressed";

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

export async function handleIssueTransition(
  issue: schema.Issue,
  transition: IssueTransition,
): Promise<void> {
  const { incident, createdIncident, linkedIssue, reopenedIncident } =
    await ensureIncidentForIssue(issue);
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
  }
  const { agentRun, queueStatus } = await queueAgentRunIfNeeded(incident);
  if (reopenedIncident) {
    const update = buildReopenedIncidentSlackUpdate({
      issueTitle: issue.title,
      queueStatus,
    });
    await postIncidentThreadMessage(incident.id, update.threadSummary);
    if (project) {
      const incidentUrl = `${WEB_ORIGIN}/incidents/${incident.id}`;
      await updateIncidentMainMessage(
        incident.id,
        `:rotating_light: ${incident.title} — ${update.rootStatus}`,
        incidentBlocks({
          emoji: "rotating_light",
          status: update.rootStatus,
          title: incident.title,
          tagline: update.rootTagline,
          projectName: project.name,
          service: incident.service,
          buttons: [{ text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" }],
          incidentId: incident.id,
        }),
      );
    }
  } else if (queueStatus === "queued") {
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
