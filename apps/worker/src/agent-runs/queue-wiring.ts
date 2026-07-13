// Production wiring for the agent-run queue: binds queue.ts (pure, tested
// against fakes) to the real database, context loader, and state handlers.
import { db, schema } from "@superlog/db";
import { asc, inArray } from "drizzle-orm";
import { loadAgentRunContext } from "../agent-run-context.js";
import { ACTIVE_STATES, createAgentRunLifecycle } from "../agent-run.js";
import { setAgentRunJobDispatch } from "./enqueue.js";
import { retryQueuedPullRequestDelivery } from "./pr-delivery.js";
import { type AgentRunQueueBoss, createAgentRunJobSender, registerAgentRunQueue } from "./queue.js";
import { resumeAgentRunFromHumanInput } from "./resume.js";
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
    listActiveRunIds: async () => {
      const rows = await db
        .select({ id: schema.agentRuns.id })
        .from(schema.agentRuns)
        .where(inArray(schema.agentRuns.state, [...ACTIVE_STATES]))
        .orderBy(asc(schema.agentRuns.updatedAt));
      return rows.map((row) => row.id);
    },
    handlers: {
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
