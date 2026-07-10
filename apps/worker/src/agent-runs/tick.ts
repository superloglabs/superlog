import { SpanStatusCode, trace } from "@opentelemetry/api";
import { db, schema } from "@superlog/db";
import { asc, eq, inArray } from "drizzle-orm";
import { loadAgentRunContext } from "../agent-run-context.js";
import {
  ACTIVE_STATES as AGENT_RUN_ACTIVE_STATES,
  createAgentRunLifecycle,
} from "../agent-run.js";
import { retryQueuedPullRequestDelivery } from "./pr-delivery.js";
import { resumeAgentRunFromHumanInput } from "./resume.js";
import { startQueuedAgentRun } from "./start-run.js";
import { syncRunningAgentRun } from "./sync.js";

const tracer = trace.getTracer("@superlog/worker");
const lifecycle = createAgentRunLifecycle(db);
const AGENT_RUN_BATCH_SIZE = parsePositiveInt(
  process.env.AGENT_RUN_BATCH_SIZE ?? process.env.INVESTIGATION_BATCH_SIZE,
  20,
  500,
);

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function tickAgentRuns(): Promise<number> {
  return tracer.startActiveSpan("agent_runs.tick", async (span) => {
    try {
      // Rotate fairly through every active run, oldest-stalest first, so we
      // don't starve the backlog. With desc(createdAt), the newest 20 runs
      // monopolised every tick — a run that fell out of the top 20 once
      // (because newer incidents arrived) would never be re-synced and got
      // stuck in 'running' forever. asc(updatedAt) drains the queue instead.
      const rows = await db.query.agentRuns.findMany({
        where: inArray(schema.agentRuns.state, [...AGENT_RUN_ACTIVE_STATES]),
        orderBy: [asc(schema.agentRuns.updatedAt)],
        limit: AGENT_RUN_BATCH_SIZE,
      });

      let processed = 0;
      for (const agentRun of rows) {
        // Always bump updated_at for the rows we visit, regardless of what
        // the handler does. Handlers can return without writing (transient
        // errors, awaiting_human with no pending reply, queued runs missing
        // a github install, …) and without this touch the same row would
        // top the asc(updatedAt) queue every tick and starve the rest of
        // the backlog. Doing this first also keeps the order stable if a
        // handler later writes a fresher updated_at.
        await db
          .update(schema.agentRuns)
          .set({ updatedAt: new Date() })
          .where(eq(schema.agentRuns.id, agentRun.id));
        const ctx = await loadAgentRunContext(agentRun);
        if (!ctx) {
          // loadAgentRunContext returns null only when the run's incident or
          // project row is gone (deleted) — a permanent condition; transient
          // DB errors throw and are handled by the surrounding span. Such a
          // run can never make progress, so failing here is the only way it
          // leaves an active state. Skipping it (the old behaviour) left it
          // rotating through the asc(updatedAt) batch forever as dead weight
          // that crowds out runnable work.
          await lifecycle.fail({
            id: agentRun.id,
            currentState: agentRun.state,
            reason: "context_unavailable",
            summary: "Investigation's incident or project no longer exists.",
            category: "infra",
          });
          continue;
        }
        processed += 1;
        if (ctx.agentRun.state === "queued" || ctx.agentRun.state === "repo_discovery") {
          await startQueuedAgentRun(ctx);
          continue;
        }
        if (ctx.agentRun.state === "running") {
          await syncRunningAgentRun(ctx);
          continue;
        }
        if (
          ctx.agentRun.state === "awaiting_human" ||
          ctx.agentRun.state === "awaiting_events" ||
          ctx.agentRun.state === "resuming"
        ) {
          await resumeAgentRunFromHumanInput(ctx);
          continue;
        }
        if (ctx.agentRun.state === "pr_retry_queued") {
          await retryQueuedPullRequestDelivery(ctx);
        }
      }
      span.setAttribute("agent_runs.processed", processed);
      return processed;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
