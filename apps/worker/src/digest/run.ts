import { postSlackMessage } from "../infra/slack/api.js";
import {
  type DigestCandidate,
  type DigestPick,
  attachCandidatesToPicks,
  buildDigestBlocks,
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

export type RunDigestForProjectDeps = {
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

export async function runDigestForProjectWorkflow(
  projectId: string,
  deps: RunDigestForProjectDeps,
  opts: { force?: boolean } = {},
): Promise<RunDigestResult> {
  const settings = await deps.repo.findProjectSettings(projectId);
  if (!settings) return { status: "skipped", reason: "no project settings row" };
  if (!opts.force && !settings.enabled) return { status: "skipped", reason: "disabled" };
  if (!settings.channelId || !settings.installationId) {
    return { status: "skipped", reason: "no slack channel configured" };
  }
  const installation = await deps.repo.findActiveSlackInstallation(settings.installationId);
  if (!installation) {
    return { status: "skipped", reason: "slack installation revoked or missing" };
  }

  const candidates = await deps.repo.gatherCandidates(projectId, deps.policy, deps.now());
  let text: string;
  let blocks: unknown[];
  let pickCount: number;
  if (candidates.length === 0) {
    if (!opts.force) {
      // Stamp last-run so an empty scheduled week doesn't retry every tick.
      await deps.repo.stampLastRun(projectId, deps.now());
      return { status: "skipped", reason: "no open bug-fix PRs in lookback window" };
    }
    text = "Superlog weekly digest: no open bug-fix PRs in the lookback window.";
    blocks = [
      { type: "header", text: { type: "plain_text", text: "Weekly digest" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "No open bug-fix PRs in the lookback window." },
      },
    ];
    pickCount = 0;
  } else {
    const picks = await deps.rank(candidates);
    const ordered = attachCandidatesToPicks(picks, candidates);
    if (ordered.length === 0) {
      return { status: "skipped", reason: "ranking returned no valid picks" };
    }
    ({ text, blocks } = buildDigestBlocks(ordered));
    pickCount = ordered.length;
  }

  const result = await deps.slack.postDigest({
    installationId: installation.id,
    botAccessToken: installation.botAccessToken,
    channelId: settings.channelId,
    text,
    blocks,
  });

  if (!result.ok) {
    deps.logger.warn(
      { scope: "digest", projectId, error: result.error },
      "digest post failed; not stamping last-run",
    );
    return { status: "skipped", reason: `slack error: ${result.error ?? "no response"}` };
  }

  await deps.repo.stampLastRun(projectId, deps.now());
  return { status: "posted", pickCount, ts: result.ts ?? null };
}

export type RunDigestsTickDeps = RunDigestForProjectDeps & {
  lastAttemptByProject: Map<string, number>;
};

// Iterates every project with digestEnabled or a pending one-shot request. Per-project
// cooldown keeps a misconfigured scheduled digest from spamming every worker
// tick; manual tests bypass both cadence and cooldown so "send now" is literal.
export async function runDigestsTickWorkflow(
  deps: RunDigestsTickDeps,
  runProject: (projectId: string, opts?: { force?: boolean }) => Promise<RunDigestResult> = (
    projectId,
    opts,
  ) => runDigestForProjectWorkflow(projectId, deps, opts),
): Promise<number> {
  const due = await deps.repo.listRunnableProjectSettings();
  const now = deps.now().getTime();
  let posted = 0;
  for (const row of due) {
    const runRequestedAt = row.runRequestedAt;
    const force = runRequestedAt != null;
    if (!row.channelId || !row.installationId) {
      if (runRequestedAt) await deps.repo.clearRunRequest(row.projectId, runRequestedAt);
      continue;
    }
    if (!force && row.lastRunAt && now - row.lastRunAt.getTime() < deps.policy.intervalMs) {
      continue;
    }
    const lastAttempt = deps.lastAttemptByProject.get(row.projectId);
    if (!force && lastAttempt && now - lastAttempt < deps.policy.retryCooldownMs) continue;
    deps.lastAttemptByProject.set(row.projectId, now);
    try {
      const result = await runProject(row.projectId, { force });
      if (result.status === "posted") posted += 1;
      deps.logger.info({ scope: "digest", projectId: row.projectId, ...result }, "digest tick");
    } catch (err) {
      deps.logger.error({ scope: "digest", projectId: row.projectId, err }, "digest tick failed");
    } finally {
      if (runRequestedAt) await deps.repo.clearRunRequest(row.projectId, runRequestedAt);
    }
  }
  return posted;
}
