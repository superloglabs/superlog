// Scheduled job: detect the agent-PR rejection signals GitHub doesn't push —
// expiry (open past the acceptance window) and human 👎 reactions (GitHub has
// no webhook event for reactions, so they can only be polled). The sweep logic
// lives in ../agent-pr-sweep.ts; this file is only the wiring: drizzle-backed
// conditional updates, per-installation GitHub tokens, analytics emitter.
//
// Hourly is enough: "rejected immediately" here means within the hour, and the
// poll volume (open PRs inside the window, one reactions GET each) sits far
// under installation rate limits. Opts out unless the GitHub App credentials
// are configured — without them no agent PR can exist, let alone be polled.

import { captureAgentPrLifecycleEvent, resolveIncidentOrg, schema } from "@superlog/db";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import {
  AGENT_PR_EXPIRY_WINDOW_DAYS_DEFAULT,
  type PollableAgentPr,
  type SweptAgentPr,
  runAgentPrLifecycleSweep,
} from "../agent-pr-sweep.js";
import { createGithubIssuesReadToken, listGithubPrReactions } from "../github-app.js";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

const log = logger.child({ scope: "agent-pr-lifecycle" });

function expiryWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.AGENT_PR_EXPIRY_WINDOW_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AGENT_PR_EXPIRY_WINDOW_DAYS_DEFAULT;
}

function hasGithubAppConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.GITHUB_APP_ID?.trim() &&
      (env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_BASE64),
  );
}

async function expireOpenPrs(
  db: JobDeps["db"],
  cutoff: Date,
  now: Date,
): Promise<SweptAgentPr[]> {
  // PRs that already carry a negative-reaction signal were counted rejected
  // when the 👎 landed; don't reject them a second time on expiry.
  return db
    .update(schema.agentPullRequests)
    .set({ expiredAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.agentPullRequests.state, "open"),
        isNull(schema.agentPullRequests.expiredAt),
        isNull(schema.agentPullRequests.negativeReactionAt),
        lt(schema.agentPullRequests.createdAt, cutoff),
      ),
    )
    .returning({
      id: schema.agentPullRequests.id,
      incidentId: schema.agentPullRequests.incidentId,
      agentRunId: schema.agentPullRequests.agentRunId,
      repoFullName: schema.agentPullRequests.repoFullName,
      prNumber: schema.agentPullRequests.prNumber,
      url: schema.agentPullRequests.url,
      createdAt: schema.agentPullRequests.createdAt,
    });
}

async function listOpenPrsForReactionPoll(
  db: JobDeps["db"],
  cutoff: Date,
): Promise<PollableAgentPr[]> {
  return db
    .select({
      id: schema.agentPullRequests.id,
      incidentId: schema.agentPullRequests.incidentId,
      agentRunId: schema.agentPullRequests.agentRunId,
      repoFullName: schema.agentPullRequests.repoFullName,
      prNumber: schema.agentPullRequests.prNumber,
      url: schema.agentPullRequests.url,
      createdAt: schema.agentPullRequests.createdAt,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.agentPullRequests)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
    )
    .where(
      and(
        eq(schema.agentPullRequests.state, "open"),
        isNull(schema.agentPullRequests.negativeReactionAt),
        isNull(schema.agentPullRequests.expiredAt),
        gte(schema.agentPullRequests.createdAt, cutoff),
      ),
    );
}

async function markNegativeReaction(
  db: JobDeps["db"],
  prId: string,
  now: Date,
): Promise<boolean> {
  // Re-assert open/unexpired in the WHERE: the PR can merge or close (webhook)
  // while its reactions request is in flight, and that stale poll must lose to
  // the terminal transition rather than record a spurious rejection.
  const updated = await db
    .update(schema.agentPullRequests)
    .set({ negativeReactionAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.agentPullRequests.id, prId),
        isNull(schema.agentPullRequests.negativeReactionAt),
        eq(schema.agentPullRequests.state, "open"),
        isNull(schema.agentPullRequests.expiredAt),
      ),
    )
    .returning({ id: schema.agentPullRequests.id });
  return updated.length > 0;
}

export const job: JobDefinition = {
  name: "agent-pr-lifecycle",
  schedule: "41 * * * *",
  create(deps: JobDeps) {
    if (!hasGithubAppConfig()) {
      log.info({}, "GitHub App credentials unset; agent-pr lifecycle sweep disabled");
      return null;
    }
    return async () => {
      // Tokens live for an hour; cache per installation for this run only so
      // a sweep never reuses one across the expiry boundary.
      const tokens = new Map<number, Promise<string>>();
      const tokenFor = (installationId: number): Promise<string> => {
        let token = tokens.get(installationId);
        if (!token) {
          token = createGithubIssuesReadToken(installationId);
          tokens.set(installationId, token);
        }
        return token;
      };
      await runAgentPrLifecycleSweep({
        windowDays: expiryWindowDays(),
        now: () => new Date(),
        expireOpenPrs: (cutoff, now) => expireOpenPrs(deps.db, cutoff, now),
        listOpenPrsForReactionPoll: (cutoff) => listOpenPrsForReactionPoll(deps.db, cutoff),
        listReactions: async (githubInstallationId, repoFullName, prNumber) =>
          listGithubPrReactions(await tokenFor(githubInstallationId), repoFullName, prNumber),
        markNegativeReaction: (prId, now) => markNegativeReaction(deps.db, prId, now),
        resolveOrg: (incidentId) => resolveIncidentOrg(incidentId, deps.db),
        capture: captureAgentPrLifecycleEvent,
        log,
      });
    };
  },
};
