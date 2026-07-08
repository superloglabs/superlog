// Slack delivery for agent chats. Chats pin the installation that saw the
// mention (agent_chats.slack_installation_id); the team-wide most-recent
// token is only the fallback for rows whose installation was deleted —
// mirroring the incident-thread precedence in the API's
// installationForIncident.
import { type AgentChat, db, schema } from "@superlog/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ChatDeliveryUnavailableError } from "../../agent-chats/workflow.js";
import { type SlackTarget, postSlackMessage } from "./api.js";

// The reply-claim takeover (agent-chats/tick.ts) assumes no post can still
// be in flight once a claim is old enough to steal; this bound is what makes
// that true, so keep it far below OUTBOUND_CLAIM_TAKEOVER_MS.
const CHAT_POST_TIMEOUT_MS = 30 * 1000;

// Returns the posted message's ts (callers use it as the durable
// proof-of-delivery marker).
export async function postAgentChatMessage(chat: AgentChat, text: string): Promise<string> {
  const target = await resolveChatSlackTarget(chat);
  if (!target) {
    throw new ChatDeliveryUnavailableError(
      `no live slack installation for chat ${chat.id} (team ${chat.slackTeamId})`,
    );
  }
  const res = await postSlackMessage({
    target,
    text,
    threadTs: chat.slackThreadTs,
    timeoutMs: CHAT_POST_TIMEOUT_MS,
  });
  if (!res?.ok) {
    throw new Error(`slack chat post failed: ${res?.error ?? "network_error"}`);
  }
  if (!res.ts) {
    // chat.postMessage returns ts on success; a missing one would corrupt
    // the proof-of-delivery marker with a non-timestamp value.
    throw new Error("slack chat post succeeded without a message ts");
  }
  return res.ts;
}

async function resolveChatSlackTarget(chat: AgentChat): Promise<SlackTarget | null> {
  const pinned = chat.slackInstallationId
    ? await db.query.slackInstallations.findFirst({
        where: and(
          eq(schema.slackInstallations.id, chat.slackInstallationId),
          isNull(schema.slackInstallations.revokedAt),
        ),
      })
    : null;
  const installation =
    pinned ??
    (await db.query.slackInstallations.findFirst({
      where: and(
        eq(schema.slackInstallations.teamId, chat.slackTeamId),
        isNull(schema.slackInstallations.revokedAt),
      ),
      orderBy: desc(
        sql`coalesce(${schema.slackInstallations.installedAt}, ${schema.slackInstallations.createdAt})`,
      ),
    }));
  if (!installation) return null;
  return {
    installationId: installation.id,
    // The chat's own channel, NOT the installation's routed incident channel.
    channelId: chat.slackChannelId,
    botToken: installation.botAccessToken,
  };
}
