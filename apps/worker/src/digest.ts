// Thin facade. The workflow lives in `digest/`:
//   - digest/domain.ts        types + pure message/blocks builders + parser
//   - digest/policy.ts        cadence and lookback policy (env-overridable)
//   - digest/repository.ts    createDigestRepository(db) pg queries
//   - digest/ranker.ts        LLM ranking with injected client + accountant
//   - digest/run.ts           runDigestForOrgWorkflow + runDigestsTickWorkflow
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@superlog/db";
import { recordTokenUsage } from "./ai-cost.js";
import type { DigestCandidate, DigestPick } from "./digest/domain.js";
import { TOP_N } from "./digest/domain.js";
import { digestPolicyFromEnv } from "./digest/policy.js";
import { asDigestLLMClient, rankCandidates } from "./digest/ranker.js";
import { createDigestRepository } from "./digest/repository.js";
import {
  createDigestSlackPoster,
  type RunDigestForOrgDeps,
  type RunDigestResult,
  runDigestForOrgWorkflow,
  runDigestsTickWorkflow,
} from "./digest/run.js";
import { logger } from "./logger.js";

const MODEL = process.env.ANTHROPIC_DIGEST_MODEL ?? "claude-sonnet-4-6";

const lastAttemptByOrg = new Map<string, number>();

export type { RunDigestResult } from "./digest/run.js";

function rankerFor(orgId: string) {
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
      : { async send() { throw new Error("digest LLM client unavailable"); } };
    return rankCandidates(candidates, {
      client,
      model: MODEL,
      logger,
      accountant: {
        record(rec) {
          recordTokenUsage({
            orgId,
            model: rec.model,
            callSite: "digest",
            usage: rec.usage,
          });
        },
      },
    });
  };
}

function makeDepsForOrg(orgId: string): RunDigestForOrgDeps {
  return {
    repo: createDigestRepository(db),
    policy: digestPolicyFromEnv(),
    slack: createDigestSlackPoster(),
    logger,
    now: () => new Date(),
    rank: rankerFor(orgId),
  };
}

export async function runDigestForOrg(
  orgId: string,
  opts: { force?: boolean } = {},
): Promise<RunDigestResult> {
  return runDigestForOrgWorkflow(orgId, makeDepsForOrg(orgId), opts);
}

export async function tickDigests(): Promise<number> {
  // Use a single repo/policy/slack/logger for the iteration, and re-resolve
  // the org-scoped rank() each time runDigestForOrg() runs.
  const baseDeps: RunDigestForOrgDeps = {
    repo: createDigestRepository(db),
    policy: digestPolicyFromEnv(),
    slack: createDigestSlackPoster(),
    logger,
    now: () => new Date(),
    // Tick path doesn't call rank() directly — it dispatches to
    // runDigestForOrg below, which wires its own org-scoped rank().
    rank: async () => [],
  };
  return runDigestsTickWorkflow(
    { ...baseDeps, lastAttemptByOrg },
    (orgId) => runDigestForOrg(orgId),
  );
}
