// Out-of-band execution for issue-transition side effects.
//
// When telemetry ingest (or an alert / observation escalation) upserts an
// issue whose transition is "new" or "recurred", the follow-up work — incident
// intake with its LLM grouping call, webhooks, Slack posts, agent-run routing —
// can take tens of seconds per issue. Running that inline in the worker tick
// serializes it with the ingest cursor: one tenant minting many new
// fingerprints stalls issue creation for every other project until its batch
// completes (and the durable cursor is only written after the whole batch).
//
// The dispatcher below breaks that coupling: the tick enqueues a small
// pg-boss job per transition and moves on, so the ingest cursor advances at
// database speed. A queue worker (registered at boot alongside the cron job
// runner) reloads the issue and runs the original handler.
//
// Delivery semantics are unchanged from the old inline path: side effects are
// at-most-once. The inline path logged-and-skipped a throwing handler; the
// queue worker does the same per job instead of relying on pg-boss retries,
// because the handler is not written to be safely re-runnable in all cases.
import type { schema } from "@superlog/db";
import type { IssueTransition } from "./incidents/workflow.js";
import { logger as defaultLogger } from "./logger.js";

export const ISSUE_TRANSITION_QUEUE = "issue-transition";

// How many queued transitions a single fetch works on. Batches are processed
// concurrently within the worker, so this is also the effective concurrency.
const WORKER_BATCH_SIZE = 5;

// Covers every dispatch site: telemetry ingest and alerts send "new" /
// "recurred"; observation escalations send "escalated".
export type DispatchIssueTransition = (
  issue: schema.Issue,
  transition: IssueTransition,
) => Promise<void>;

export type IssueTransitionJobData = {
  issueId: string;
  projectId: string;
  transition: IssueTransition;
};

type LoggerLike = Pick<typeof defaultLogger, "warn" | "error">;

// The slice of pg-boss the dispatcher and worker need. Declared structurally
// so tests can substitute fakes without a database.
export type TransitionQueueBoss = {
  createQueue(name: string, options?: unknown): Promise<unknown>;
  work(
    name: string,
    options: { batchSize: number },
    handler: (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>,
  ): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<unknown>;
};

function parseJobData(data: unknown): IssueTransitionJobData | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.issueId !== "string" || typeof record.projectId !== "string") return null;
  if (
    record.transition !== "new" &&
    record.transition !== "recurred" &&
    record.transition !== "escalated"
  ) {
    return null;
  }
  return {
    issueId: record.issueId,
    projectId: record.projectId,
    transition: record.transition,
  };
}

// Returns a dispatch function that enqueues instead of executing.
// Without a queue (no DATABASE_URL / boss failed to start) — or when the
// enqueue itself fails — it falls back to running the handler inline, so a
// degraded queue never drops transitions, it just loses the latency win.
//
// The inline fallback on a send error is a deliberate at-least-once choice:
// the realistic send failures (queue missing, database unreachable) commit
// nothing, so inline is the only delivery. The narrow case of a connection
// dropping AFTER pg-boss committed the row can run the transition twice —
// accepted, because a repeat execution sees the already-created incident
// (`createdIncident` is false on re-entry) and skips notifications, whereas
// dropping the transition could leave a new issue without an incident
// forever (later occurrences of the same fingerprint are "seen", which
// never re-enters intake).
export function createIssueTransitionDispatcher(opts: {
  boss: Pick<TransitionQueueBoss, "send"> | null;
  inline: DispatchIssueTransition;
  logger?: LoggerLike;
}): DispatchIssueTransition {
  const logger = opts.logger ?? defaultLogger;
  return async (issue, transition) => {
    if (!opts.boss) {
      await opts.inline(issue, transition);
      return;
    }
    const data: IssueTransitionJobData = {
      issueId: issue.id,
      projectId: issue.projectId,
      transition,
    };
    try {
      // singletonKey dedupes while a matching job is queued: a rapid
      // re-dispatch of the same (issue, transition) collapses to one job.
      // Event counters were already bumped by the upsert, so one execution
      // of the side effects is all that's needed.
      await opts.boss.send(ISSUE_TRANSITION_QUEUE, data, {
        singletonKey: `${issue.id}:${transition}`,
      });
    } catch (err) {
      logger.warn(
        {
          scope: "issue-transitions",
          issueId: issue.id,
          transition,
          err: err instanceof Error ? err.message : String(err),
        },
        "enqueue failed; running issue transition inline",
      );
      await opts.inline(issue, transition);
    }
  };
}

// Register the queue and its worker. Jobs in a batch run concurrently; each
// job's failure is logged and swallowed (at-most-once, matching the previous
// inline behavior) so one poisoned transition can't wedge or re-run the rest.
export async function registerIssueTransitionWorker(
  boss: Pick<TransitionQueueBoss, "createQueue" | "work">,
  opts: {
    handle: DispatchIssueTransition;
    loadIssue: (issueId: string) => Promise<schema.Issue | null | undefined>;
    logger?: LoggerLike;
  },
): Promise<void> {
  const logger = opts.logger ?? defaultLogger;
  await boss.createQueue(ISSUE_TRANSITION_QUEUE);
  await boss.work(ISSUE_TRANSITION_QUEUE, { batchSize: WORKER_BATCH_SIZE }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        const data = parseJobData(job.data);
        if (!data) {
          logger.warn(
            { scope: "issue-transitions", jobId: job.id },
            "skipping malformed issue-transition job",
          );
          return;
        }
        try {
          const issue = await opts.loadIssue(data.issueId);
          if (!issue) {
            logger.warn(
              { scope: "issue-transitions", issueId: data.issueId, jobId: job.id },
              "issue no longer exists; skipping transition",
            );
            return;
          }
          await opts.handle(issue, data.transition);
        } catch (err) {
          logger.error(
            {
              scope: "issue-transitions",
              issueId: data.issueId,
              transition: data.transition,
              projectId: data.projectId,
              err: err instanceof Error ? err.message : String(err),
            },
            "issue transition failed; skipping",
          );
        }
      }),
    );
  });
}
