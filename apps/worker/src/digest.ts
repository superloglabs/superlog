// Thin facade. The workflow lives in `digest/`:
//   - digest/domain.ts        types + pure message/blocks builders + parser
//   - digest/policy.ts        cadence and lookback policy (env-overridable)
//   - digest/repository.ts    createDigestRepository(db) pg queries
//   - digest/ranker.ts        LLM ranking with injected client + accountant
//   - digest/run.ts           runDigestForProjectWorkflow + runDigestsTickWorkflow
import Anthropic from "@anthropic-ai/sdk";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { recordTokenUsage } from "./ai-usage.js";
import type { DigestCandidate, DigestPick } from "./digest/domain.js";
import { TOP_N } from "./digest/domain.js";
import { digestPolicyFromEnv } from "./digest/policy.js";
import { asDigestLLMClient, rankCandidates } from "./digest/ranker.js";
import { createDigestRepository } from "./digest/repository.js";
import {
  type RunDigestForProjectDeps,
  type RunDigestResult,
  createDigestSlackPoster,
  runDigestForProjectWorkflow,
  runDigestsTickWorkflow,
} from "./digest/run.js";
import { logger } from "./logger.js";

const MODEL = process.env.ANTHROPIC_DIGEST_MODEL ?? "claude-sonnet-4-6";

const lastAttemptByProject = new Map<string, number>();

export type { RunDigestResult } from "./digest/run.js";

function rankerForProject(projectId: string) {
  return async (candidates: DigestCandidate[]): Promise<DigestPick[]> => {
    if (candidates.length === 0) return [];
    const apiKey = process.env.ANTHROPIC_API_KEY;
    // The ranker short-circuits to trivialPicks when there are ≤ TOP_N
    // candidates, so we can skip the LLM (and the env check) in that case.
    if (!apiKey && candidates.length > TOP_N) {
      throw new Error("ANTHROPIC_API_KEY is required for digest ranking");
    }
    const client = apiKey
      ? asDigestLLMClient(new Anthropic({ apiKey }))
      : {
          async send() {
            throw new Error("digest LLM client unavailable");
          },
        };
    return rankCandidates(candidates, {
      client,
      model: MODEL,
      logger,
      accountant: {
        async record(rec) {
          const project = await db.query.projects.findFirst({
            where: eq(schema.projects.id, projectId),
            columns: { orgId: true },
          });
          if (!project) throw new Error(`project ${projectId} not found for digest accounting`);
          await recordTokenUsage({
            orgId: project.orgId,
            model: rec.model,
            callSite: "digest",
            usage: rec.usage,
          });
        },
      },
    });
  };
}

function makeDepsForProject(projectId: string): RunDigestForProjectDeps {
  return {
    repo: createDigestRepository(db),
    policy: digestPolicyFromEnv(),
    slack: createDigestSlackPoster(),
    logger,
    now: () => new Date(),
    rank: rankerForProject(projectId),
  };
}

export async function runDigestForProject(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<RunDigestResult> {
  return runDigestForProjectWorkflow(projectId, makeDepsForProject(projectId), opts);
}

export async function tickDigests(): Promise<number> {
  // Use a single repo/policy/slack/logger for the iteration, and re-resolve
  // project-scoped ranking/accounting for each digest.
  const baseDeps: RunDigestForProjectDeps = {
    repo: createDigestRepository(db),
    policy: digestPolicyFromEnv(),
    slack: createDigestSlackPoster(),
    logger,
    now: () => new Date(),
    // Tick dispatches to runDigestForProject below, which wires its own rank().
    rank: async () => [],
  };
  return runDigestsTickWorkflow({ ...baseDeps, lastAttemptByProject }, (projectId, opts) =>
    runDigestForProject(projectId, opts),
  );
}
