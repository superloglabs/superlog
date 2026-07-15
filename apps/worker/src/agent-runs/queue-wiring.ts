// Production wiring for the agent-run queue: binds queue.ts (pure, tested
// against fakes) to the real database, context loader, and state handlers.
import { db, schema } from "@superlog/db";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { loadAgentRunContext } from "../agent-run-context.js";
import { ACTIVE_STATES, createAgentRunLifecycle } from "../agent-run.js";
import { setAgentRunJobDispatch } from "./enqueue.js";
import { listPendingLinearHandoffRunIds, reconcilePendingLinearHandoff } from "./linear-handoff.js";
import { retryQueuedPullRequestDelivery } from "./pr-delivery.js";
import { type AgentRunQueueBoss, createAgentRunJobSender, registerAgentRunQueue } from "./queue.js";
import { resumeAgentRunFromHumanInput } from "./resume.js";
import {
  hasPendingDetachedAgentRunSession,
  listPendingDetachedAgentRunIds,
  terminatePendingAgentRunSessions,
} from "./session-termination.js";
import { startQueuedAgentRun } from "./start-run.js";
import { syncRunningAgentRun } from "./sync.js";

const lifecycle = createAgentRunLifecycle(db);

function parsePositive(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// Register the advance + sweep queues on the boss and install the process-wide
// dispatch hook so run creation enqueues immediately.
export async function startAgentRunQueue(boss: AgentRunQueueBoss): Promise<void> {
  await registerAgentRunQueue(boss, {
    loadRun: async (id) =>
      db.query.agentRuns.findFirst({ where: (runs, { eq }) => eq(runs.id, id) }),
    loadContext: loadAgentRunContext,
    failContextUnavailable: async (agentRun) => {
      await lifecycle.fail({
        id: agentRun.id,
        currentState: agentRun.state,
        reason: "context_unavailable",
        summary: "Investigation's incident or project no longer exists.",
        category: "infra",
      });
    },
    hasDetachedSessionTermination: hasPendingDetachedAgentRunSession,
    listActiveRunIds: async () => {
      const [rows, pendingHandoffs, pendingDetachedSessions] = await Promise.all([
        db
          .select({ id: schema.agentRuns.id })
          .from(schema.agentRuns)
          .where(
            or(
              inArray(schema.agentRuns.state, [...ACTIVE_STATES]),
              and(
                eq(schema.agentRuns.providerSessionStatus, "termination_pending"),
                isNotNull(schema.agentRuns.providerSessionId),
              ),
            ),
          )
          .orderBy(asc(schema.agentRuns.updatedAt)),
        listPendingLinearHandoffRunIds(),
        listPendingDetachedAgentRunIds(),
      ]);
      return [
        ...new Set([...rows.map((row) => row.id), ...pendingHandoffs, ...pendingDetachedSessions]),
      ];
    },
    handlers: {
      terminateSession: async (agentRun) => {
        await terminatePendingAgentRunSessions(agentRun);
      },
      reconcileHandoff: async (ctx) => {
        await reconcilePendingLinearHandoff(ctx);
      },
      start: startQueuedAgentRun,
      sync: syncRunningAgentRun,
      resume: resumeAgentRunFromHumanInput,
      retryPrDelivery: retryQueuedPullRequestDelivery,
    },
    concurrency: parsePositive(process.env.AGENT_RUN_JOB_CONCURRENCY),
    jobTimeoutMs: parsePositive(process.env.AGENT_RUN_JOB_TIMEOUT_MS),
  });
  setAgentRunJobDispatch(createAgentRunJobSender(boss));
}
