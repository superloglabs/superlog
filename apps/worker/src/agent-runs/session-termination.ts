import { db, schema } from "@superlog/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createAgentRunLifecycle } from "../agent-run.js";
import type { AgentRunnerBackend } from "../agent-runner-backend.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";

const lifecycle = createAgentRunLifecycle(db);

export type DetachedSessionTermination = {
  id: string;
  runtime: string;
  providerSessionId: string;
};

function parseDetachedSessionTermination(
  event: Pick<schema.IncidentEvent, "id" | "detail">,
): DetachedSessionTermination | null {
  const runtime = event.detail?.runtime;
  const providerSessionId = event.detail?.providerSessionId;
  if (typeof runtime !== "string" || typeof providerSessionId !== "string") return null;
  return { id: event.id, runtime, providerSessionId };
}

async function listDetached(agentRunId: string): Promise<DetachedSessionTermination[]> {
  const events = await db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, agentRunId),
      eq(schema.incidentEvents.kind, "internal_agent_session_termination_pending"),
      isNull(schema.incidentEvents.processedAt),
    ),
    columns: { id: true, detail: true },
  });
  return events.flatMap((event) => {
    const parsed = parseDetachedSessionTermination(event);
    return parsed ? [parsed] : [];
  });
}

export async function hasPendingDetachedAgentRunSession(agentRunId: string): Promise<boolean> {
  const event = await db.query.incidentEvents.findFirst({
    where: and(
      eq(schema.incidentEvents.agentRunId, agentRunId),
      eq(schema.incidentEvents.kind, "internal_agent_session_termination_pending"),
      isNull(schema.incidentEvents.processedAt),
    ),
    columns: { id: true },
  });
  return event !== undefined;
}

export async function listPendingDetachedAgentRunIds(limit?: number): Promise<string[]> {
  const rows = await db
    .select({ agentRunId: schema.agentRuns.id })
    .from(schema.agentRuns)
    .innerJoin(schema.incidentEvents, eq(schema.incidentEvents.agentRunId, schema.agentRuns.id))
    .where(
      and(
        eq(schema.incidentEvents.kind, "internal_agent_session_termination_pending"),
        isNull(schema.incidentEvents.processedAt),
      ),
    )
    .groupBy(schema.agentRuns.id, schema.agentRuns.updatedAt)
    .orderBy(asc(schema.agentRuns.updatedAt), asc(schema.agentRuns.id))
    .limit(limit ?? 1000);
  return rows.map((row) => row.agentRunId);
}

export async function terminatePendingAgentRunSessions(
  agentRun: schema.AgentRun,
  deps: {
    getRunnerBackend(runtime: string): AgentRunnerBackend | Promise<AgentRunnerBackend>;
    listDetached(agentRunId: string): Promise<DetachedSessionTermination[]>;
    markOwnedTerminated(opts: { id: string; providerSessionId: string }): Promise<void>;
    markDetachedTerminated(eventId: string): Promise<void>;
  } = {
    getRunnerBackend: getAgentRunnerBackend,
    listDetached,
    markOwnedTerminated: (opts) => lifecycle.markSessionTerminated(opts),
    markDetachedTerminated: async (eventId) => {
      await db
        .update(schema.incidentEvents)
        .set({ processedAt: new Date() })
        .where(
          and(
            eq(schema.incidentEvents.id, eventId),
            eq(schema.incidentEvents.kind, "internal_agent_session_termination_pending"),
            isNull(schema.incidentEvents.processedAt),
          ),
        );
    },
  },
): Promise<boolean> {
  let terminated = false;
  const detached = await deps.listDetached(agentRun.id);
  for (const pending of detached) {
    const runner = await deps.getRunnerBackend(pending.runtime);
    await runner.terminate(pending.providerSessionId);
    await deps.markDetachedTerminated(pending.id);
    terminated = true;
  }

  const ownedSessionId = agentRun.providerSessionId;
  if (agentRun.providerSessionStatus === "termination_pending" && ownedSessionId) {
    const runner = await deps.getRunnerBackend(agentRun.runtime);
    await runner.terminate(ownedSessionId);
    await deps.markOwnedTerminated({ id: agentRun.id, providerSessionId: ownedSessionId });
    terminated = true;
  }
  return terminated;
}
