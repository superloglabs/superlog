// Autorecovery agent: hourly LLM pass over open incidents that haven't seen
// activity recently. The agent looks at the incident's signal in
// ClickHouse and decides whether it appears to have stopped happening
// because of an external/config fix (not a code change on our side).
//
// On a high-confidence "yes", we write a row to
// `incident_resolution_proposals`, post a threaded Slack message in the
// incident thread with Confirm / Dismiss buttons, and let a human decide.
// Confirming flips the incident closed via the shared resolveIncident()
// helper (apps/api/src/slack.ts handles the button); dismissing records a
// 24h cooldown so we don't re-propose.
//
// Design choices captured per-layer:
//   - autorecovery/policy.ts encodes the thresholds and confidence rules
//   - autorecovery/domain.ts is the pure model (parsers, formatters,
//     proposal-outcome decision)
//   - autorecovery/repository.ts owns pg, metrics-repository.ts owns CH
//   - autorecovery/agent.ts runs the tool-use loop against an injectable
//     LLM client so tests substitute canned responses
//   - autorecovery/tick.ts is the application service
//
// This file is now a thin facade that wires real deps and re-exports the
// two public entry points the worker tick calls.
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@superlog/db";
import { recordTokenUsage } from "./ai-usage.js";
import {
  asLLMClient,
  type AutorecoveryTokenAccountant,
  runAutorecoveryAgent,
} from "./autorecovery/agent.js";
import type { CandidateIncident } from "./autorecovery/domain.js";
import {
  type AutorecoveryPolicy,
  autorecoveryPolicyFromEnv,
} from "./autorecovery/policy.js";
import {
  createAutorecoveryMetricsRepository,
  defaultClickhouseClient,
} from "./autorecovery/metrics-repository.js";
import { createAutorecoveryRepository } from "./autorecovery/repository.js";
import { createSlackPoster } from "./autorecovery/slack.js";
import {
  runAutorecoveryNow as runAutorecoveryNowApp,
  runAutorecoveryTick as runAutorecoveryTickApp,
  type TickDeps,
} from "./autorecovery/tick.js";
import { logger } from "./logger.js";

const MODEL = process.env.ANTHROPIC_AUTORECOVERY_MODEL ?? "claude-sonnet-4-6";

function makeDeps(apiKey: string, policy: AutorecoveryPolicy): TickDeps {
  const repo = createAutorecoveryRepository(db);
  const metrics = createAutorecoveryMetricsRepository(defaultClickhouseClient);
  const slack = createSlackPoster();
  const anthropic = new Anthropic({ apiKey });
  const client = asLLMClient(anthropic);

  return {
    policy,
    repo,
    slack,
    logger,
    now: () => new Date(),
    selectCandidates: (now, p, opts) => repo.selectCandidates(now, p, opts),
    async runAgent(incident: CandidateIncident) {
      const project = await repo.findProject(incident.projectId);
      if (!project) return null;
      const accountant: AutorecoveryTokenAccountant = {
        async record(input) {
          await recordTokenUsage({
            orgId: project.orgId,
            projectId: project.id,
            model: input.model,
            callSite: "autorecovery",
            usage: input.usage,
          });
        },
      };
      return runAutorecoveryAgent(incident, {
        client,
        model: MODEL,
        metrics,
        accountant,
        logger,
        maxIterations: policy.maxAgentIterations,
        now: () => new Date(),
      });
    },
  };
}

// Entry point called from the main worker tick loop. Throttled by
// `worker_state.cursor` — every worker tick checks the cursor and
// short-circuits if the last autorecovery pass was recent.
//
// Prefer startAutorecoveryJob() (which runs the pass on a pg-boss cron) so
// this inline path is used only as a fallback when pg-boss is unavailable.
export async function tickAutorecovery(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 0;
  const policy = autorecoveryPolicyFromEnv();
  return runAutorecoveryTickApp(makeDeps(apiKey, policy));
}

// Manual trigger used in tests and the end-to-end checkout — bypasses the
// hourly throttle so we can drive an autorecovery pass on demand.
export async function runAutorecoveryNow(opts?: {
  incidentIds?: string[];
}): Promise<{ candidates: number; proposalsWritten: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { candidates: 0, proposalsWritten: 0 };
  const policy = autorecoveryPolicyFromEnv();
  return runAutorecoveryNowApp(makeDeps(apiKey, policy), opts);
}

// The slice of the pg-boss API this function needs — a strict subset of
// the JobBoss interface so callers can pass any compatible boss without
// importing pg-boss types directly.
type AutorecoveryBoss = {
  createQueue(name: string, options?: unknown): Promise<unknown>;
  work(name: string, handler: (jobs: unknown[]) => Promise<unknown>): Promise<unknown>;
  schedule(name: string, cron: string, data?: unknown, options?: unknown): Promise<unknown>;
};

// Register autorecovery as a standalone hourly pg-boss cron job.
//
// Running the LLM pass out-of-band (rather than inline in the worker tick)
// prevents the 50-candidate serial loop (~12 min at scale) from blocking the
// tick heartbeat and triggering the stale-heartbeat alarm.
//
// Throws when ANTHROPIC_API_KEY is absent so the caller can detect that the
// job was skipped and fall back to the inline tickAutorecovery() path instead
// (which returns 0 immediately when there is no API key anyway).
export async function startAutorecoveryJob(boss: AutorecoveryBoss): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set; autorecovery job skipped");
  await boss.createQueue("autorecovery", { policy: "exclusive" });
  await boss.work("autorecovery", async () => {
    await runAutorecoveryNow();
  });
  // Run once per hour, aligned to the top of the hour. pg-boss uses
  // minute-granular cron; the internal per-incident reevaluation cooldown
  // (24 h) prevents re-chewing the same incidents on every pass.
  await boss.schedule("autorecovery", "0 * * * *");
  logger.info({ scope: "autorecovery" }, "autorecovery job registered (hourly pg-boss cron)");
}
