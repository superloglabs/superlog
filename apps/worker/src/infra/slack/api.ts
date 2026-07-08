// Low-level Slack Web API helpers shared by every worker module that posts
// to Slack on behalf of a project (incident threads, autorecovery
// proposals, future digest pings, …). Centralised so we have one place
// that handles bot-token revocation: if Slack returns `token_revoked` or a
// peer, we mark the installation revoked in pg so we stop pinging.
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { logger } from "../../logger.js";

const REVOKE_ERRORS = new Set([
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
]);

export type SlackTarget = {
  installationId: string;
  channelId: string;
  botToken: string;
};

export type SlackPostMessageResponse = { ok: boolean; error?: string; ts?: string };
export type SlackUpdateMessageResponse = { ok: boolean; error?: string };

async function markInstallationRevoked(installationId: string): Promise<void> {
  await db
    .update(schema.slackInstallations)
    .set({ revokedAt: new Date() })
    .where(eq(schema.slackInstallations.id, installationId));
}

export async function postSlackMessage(opts: {
  target: SlackTarget;
  text: string;
  blocks?: unknown[];
  threadTs?: string | null;
  // Bounds the whole request. Callers whose retry logic assumes a post can't
  // still be in flight after some window (the chat reply claim takeover)
  // MUST set this well below that window; fetch has no default timeout.
  timeoutMs?: number;
}): Promise<SlackPostMessageResponse | null> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${opts.target.botToken}`,
      },
      body: JSON.stringify({
        channel: opts.target.channelId,
        thread_ts: opts.threadTs ?? undefined,
        text: opts.text,
        ...(opts.blocks ? { blocks: opts.blocks } : {}),
      }),
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    const data = (await res.json()) as SlackPostMessageResponse;
    if (!data.ok && data.error && REVOKE_ERRORS.has(data.error)) {
      await markInstallationRevoked(opts.target.installationId);
    }
    return data;
  } catch (err) {
    logger.warn({ scope: "slack", err }, "chat.postMessage failed");
    return null;
  }
}

export async function updateSlackMessage(opts: {
  target: SlackTarget;
  ts: string;
  text: string;
  blocks?: unknown[];
}): Promise<SlackUpdateMessageResponse | null> {
  try {
    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${opts.target.botToken}`,
      },
      body: JSON.stringify({
        channel: opts.target.channelId,
        ts: opts.ts,
        text: opts.text,
        ...(opts.blocks ? { blocks: opts.blocks } : {}),
      }),
    });
    const data = (await res.json()) as SlackUpdateMessageResponse;
    if (!data.ok) {
      logger.warn(
        { scope: "slack", error: data.error, ts: opts.ts, channel: opts.target.channelId },
        "chat.update returned not-ok",
      );
      if (data.error && REVOKE_ERRORS.has(data.error)) {
        await markInstallationRevoked(opts.target.installationId);
      }
    }
    return data;
  } catch (err) {
    logger.warn({ scope: "slack", err }, "chat.update failed");
    return null;
  }
}
