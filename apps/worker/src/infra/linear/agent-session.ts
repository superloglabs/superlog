import { createLinearAgentActivity, db, type LinearAgentActivityType, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "../../logger.js";

const log = logger.child({ scope: "linear_agent_session" });

type LinearIncidentTarget = { accessToken: string; agentSessionId: string };

export type LinearIncidentActivityDeps = {
  findTarget: (incidentId: string) => Promise<LinearIncidentTarget | null>;
  createActivity: typeof createLinearAgentActivity;
};

const defaultDeps: LinearIncidentActivityDeps = {
  async findTarget(incidentId) {
    const session = await db.query.linearAgentSessions.findFirst({
      where: and(
        eq(schema.linearAgentSessions.incidentId, incidentId),
        eq(schema.linearAgentSessions.kind, "incident"),
      ),
    });
    if (!session) return null;
    const installation = await db.query.linearInstallations.findFirst({
      where: and(
        eq(schema.linearInstallations.id, session.installationId),
        isNull(schema.linearInstallations.revokedAt),
      ),
    });
    return installation
      ? { accessToken: installation.accessToken, agentSessionId: session.agentSessionId }
      : null;
  },
  createActivity: createLinearAgentActivity,
};

// Best-effort channel-out delivery for investigations delegated from Linear.
// The Linear issue is already tracked as the run's known ticket; activities
// close the native AgentSession loop without creating a duplicate issue.
export async function postLinearIncidentActivity(
  incidentId: string,
  type: Extract<LinearAgentActivityType, "response" | "elicitation" | "error">,
  body: string,
  deps: LinearIncidentActivityDeps = defaultDeps,
): Promise<void> {
  let target: LinearIncidentTarget | null = null;
  try {
    target = await deps.findTarget(incidentId);
    if (!target) return;
    await deps.createActivity({ ...target, type, body });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        incident_id: incidentId,
        linear_agent_session_id: target?.agentSessionId,
        activity_type: type,
      },
      "failed to post investigation activity to Linear",
    );
  }
}

export function postLinearIncidentResponse(incidentId: string, body: string): Promise<void> {
  return postLinearIncidentActivity(incidentId, "response", body);
}

export function postLinearIncidentElicitation(incidentId: string, body: string): Promise<void> {
  return postLinearIncidentActivity(incidentId, "elicitation", body);
}

export function postLinearIncidentError(incidentId: string, body: string): Promise<void> {
  return postLinearIncidentActivity(incidentId, "error", body);
}
