import { db, schema } from "@superlog/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import { postIncidentThreadMessage } from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { failAgentRun, isTransientError } from "./status.js";

const agentRunLifecycle = createAgentRunLifecycle(db);

export async function resumeAwaitingHumanAgentRun(ctx: AgentRunContext): Promise<void> {
  const sessionId = ctx.agentRun.providerSessionId;
  if (!sessionId) {
    // Paused in startQueuedAgentRun before any managed session was created
    // (repo discovery couldn't pick a candidate). Bounce back to "queued" on a
    // human reply so the next tick reloads ctx with the repo the human named.
    const humanReplies = await db.query.incidentEvents.findMany({
      where: and(
        eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
        eq(schema.incidentEvents.kind, "human_reply"),
        isNull(schema.incidentEvents.processedAt),
      ),
    });
    if (humanReplies.length === 0) return;
    await agentRunLifecycle.requeueAfterHumanReply({
      id: ctx.agentRun.id,
      currentState: ctx.agentRun.state,
    });
    await db
      .update(schema.incidentEvents)
      .set({ processedAt: new Date() })
      .where(
        inArray(
          schema.incidentEvents.id,
          humanReplies.map((event) => event.id),
        ),
      );
    return;
  }
  if (ctx.agentRun.resumeCount >= ctx.automation.maxHumanResumeCount) {
    await failAgentRun(
      ctx,
      "human_resume_budget_exhausted",
      "Investigation stalled after exhausting the human resume budget.",
    );
    return;
  }

  const humanReplies = await db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
      eq(schema.incidentEvents.kind, "human_reply"),
      isNull(schema.incidentEvents.processedAt),
    ),
    orderBy: [desc(schema.incidentEvents.createdAt)],
  });
  if (humanReplies.length === 0) return;

  const combined = humanReplies
    .map((event) => event.summary ?? "")
    .filter(Boolean)
    .reverse()
    .join("\n\n");

  try {
    const runner = await getAgentRunnerBackend(ctx.agentRun.runtime);
    await runner.resume(sessionId, combined);
    await agentRunLifecycle.resumeRunning({
      id: ctx.agentRun.id,
      currentState: ctx.agentRun.state,
      currentResumeCount: ctx.agentRun.resumeCount,
    });
    logger.info(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        session_id: sessionId,
        resume_count: ctx.agentRun.resumeCount + 1,
        reply_count: humanReplies.length,
      },
      "agent run resumed from human reply",
    );
    await db
      .update(schema.incidentEvents)
      .set({ processedAt: new Date() })
      .where(
        inArray(
          schema.incidentEvents.id,
          humanReplies.map((event) => event.id),
        ),
      );
  } catch (err) {
    if (isTransientError(err)) {
      logger.error(
        {
          err,
          scope: "agent_run",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          project_id: ctx.project.id,
          org_id: ctx.project.orgId,
          provider_session_id: sessionId,
          stage: "resume",
        },
        "agent run resume hit transient error; will retry on next tick",
      );
      return;
    }
    await failAgentRun(ctx, "resume_failed", "Failed to resume agent run.", { err });
    return;
  }
  await postIncidentThreadMessage(
    ctx.incident.id,
    ":arrow_forward: Investigation resumed with human input.",
  ).catch((err) =>
    logger.error(
      {
        err,
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        stage: "resume_notify",
      },
      "failed to post agent run resume notification",
    ),
  );
}
