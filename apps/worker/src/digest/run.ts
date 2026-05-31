import type { schema } from "@superlog/db";
import { postSlackMessage } from "../infra/slack/api.js";
import {
  attachCandidatesToPicks,
  buildDigestBlocks,
  type DigestCandidate,
  type DigestPick,
} from "./domain.js";
import type { DigestPolicy } from "./policy.js";
import type { DigestRepository } from "./repository.js";

export type DigestLogger = {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
};

export type DigestSlackPoster = {
  postDigest(input: {
    installationId: string;
    botAccessToken: string;
    channelId: string;
    text: string;
    blocks: unknown[];
  }): Promise<{ ok: boolean; ts?: string; error?: string }>;
};

export function createDigestSlackPoster(): DigestSlackPoster {
  return {
    async postDigest(input) {
      const data = await postSlackMessage({
        target: {
          installationId: input.installationId,
          channelId: input.channelId,
          botToken: input.botAccessToken,
        },
        text: input.text,
        blocks: input.blocks,
      });
      if (!data) return { ok: false, error: "network_error" };
      return data;
    },
  };
}

export type RunDigestForOrgDeps = {
  repo: DigestRepository;
  rank(candidates: DigestCandidate[]): Promise<DigestPick[]>;
  slack: DigestSlackPoster;
  logger: DigestLogger;
  policy: DigestPolicy;
  now(): Date;
};

export type RunDigestResult =
  | { status: "skipped"; reason: string }
  | { status: "posted"; pickCount: number; ts: string | null };

export async function runDigestForOrgWorkflow(
  orgId: string,
  deps: RunDigestForOrgDeps,
  opts: { force?: boolean } = {},
): Promise<RunDigestResult> {
  const settings = await deps.repo.findOrgSettings(orgId);
  if (!settings) return { status: "skipped", reason: "no org_agent_settings row" };
  if (!opts.force && !settings.digestEnabled) return { status: "skipped", reason: "disabled" };
  if (!settings.digestSlackChannelId || !settings.digestSlackInstallationId) {
    return { status: "skipped", reason: "no slack channel configured" };
  }
  const installation = await deps.repo.findActiveSlackInstallation(
    settings.digestSlackInstallationId,
  );
  if (!installation) {
    return { status: "skipped", reason: "slack installation revoked or missing" };
  }

  const candidates = await deps.repo.gatherCandidates(orgId, deps.policy, deps.now());
  if (candidates.length === 0) {
    // Stamp last-run anyway so we don't hammer the LLM weekly when there's nothing to send.
    await deps.repo.stampLastRun(orgId, deps.now());
    return { status: "skipped", reason: "no open bug-fix PRs in lookback window" };
  }

  const picks = await deps.rank(candidates);
  const ordered = attachCandidatesToPicks(picks, candidates);
  if (ordered.length === 0) {
    return { status: "skipped", reason: "ranking returned no valid picks" };
  }

  const { text, blocks } = buildDigestBlocks(ordered);
  const result = await deps.slack.postDigest({
    installationId: installation.id,
    botAccessToken: installation.botAccessToken,
    channelId: settings.digestSlackChannelId,
    text,
    blocks,
  });

  if (!result.ok) {
    deps.logger.warn(
      { scope: "digest", orgId, error: result.error },
      "digest post failed; not stamping last-run",
    );
    return { status: "skipped", reason: `slack error: ${result.error ?? "no response"}` };
  }

  await deps.repo.stampLastRun(orgId, deps.now());
  return { status: "posted", pickCount: ordered.length, ts: result.ts ?? null };
}

export type RunDigestsTickDeps = RunDigestForOrgDeps & {
  lastAttemptByOrg: Map<string, number>;
};

// Iterates every org with digestEnabled. Per-org cooldown keeps a
// misconfigured org (revoked Slack, missing installation) from spamming
// every worker tick — successful posts use the long cadence via
// digestLastRunAt; failed attempts back off for `retryCooldownMs`.
export async function runDigestsTickWorkflow(
  deps: RunDigestsTickDeps,
  runOrg: (orgId: string) => Promise<RunDigestResult> = (orgId) =>
    runDigestForOrgWorkflow(orgId, deps),
): Promise<number> {
  const due = await deps.repo.listEnabledDigestSettings();
  const now = deps.now().getTime();
  let posted = 0;
  for (const row of due) {
    if (!row.digestSlackChannelId || !row.digestSlackInstallationId) continue;
    if (row.digestLastRunAt && now - row.digestLastRunAt.getTime() < deps.policy.intervalMs) {
      continue;
    }
    const lastAttempt = deps.lastAttemptByOrg.get(row.orgId);
    if (lastAttempt && now - lastAttempt < deps.policy.retryCooldownMs) continue;
    deps.lastAttemptByOrg.set(row.orgId, now);
    try {
      const result = await runOrg(row.orgId);
      if (result.status === "posted") posted += 1;
      deps.logger.info({ scope: "digest", orgId: row.orgId, ...result }, "digest tick");
    } catch (err) {
      deps.logger.error(
        { scope: "digest", orgId: row.orgId, err },
        "digest tick failed",
      );
    }
  }
  return posted;
}

// Type-only re-export so the orgAgentSettings shape lives in @superlog/db
// and consumers of run.ts don't need a second import.
export type OrgAgentSettings = schema.OrgAgentSettings;
