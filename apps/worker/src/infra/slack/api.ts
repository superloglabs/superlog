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

export type SlackJoinResult = { ok: true } | { ok: false; error: string };

// Best-effort membership repair before posting a notification root: Slack only
// delivers `message.channels` events for channels the bot is a member of, so
// a never-joined channel silently swallows every thread reply to the agent.
// Idempotent — `already_in_channel` comes back as ok:true with a warning.
// Fails softly (`missing_scope` on pre-channels:join installs, private
// channels) and the caller decides whether to hint the user instead.
export async function joinSlackChannel(target: SlackTarget): Promise<SlackJoinResult> {
  try {
    const res = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${target.botToken}`,
      },
      body: JSON.stringify({ channel: target.channelId }),
      // Pre-post path: a Slack stall must degrade to the soft-failure branch,
      // not hold up the notification (fetch has no default timeout).
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      if (data.error && REVOKE_ERRORS.has(data.error)) {
        await markInstallationRevoked(target.installationId);
      }
      return { ok: false, error: data.error ?? "unknown" };
    }
    return { ok: true };
  } catch (err) {
    logger.warn({ scope: "slack", err }, "conversations.join failed");
    return { ok: false, error: "network_error" };
  }
}

// Whether the bot is a member of the channel, or null when Slack didn't say
// (API error, network failure) — callers must treat null as "unknown", not
// "not a member".
export async function fetchChannelMembership(target: SlackTarget): Promise<boolean | null> {
  try {
    const url = new URL("https://slack.com/api/conversations.info");
    url.searchParams.set("channel", target.channelId);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${target.botToken}` },
      // Pre-post path, same as the join above: bounded so a stall degrades to
      // "membership unknown" instead of delaying the notification.
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      channel?: { is_member?: boolean };
    };
    if (!data.ok || typeof data.channel?.is_member !== "boolean") return null;
    return data.channel.is_member;
  } catch (err) {
    logger.warn({ scope: "slack", err }, "conversations.info failed");
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
