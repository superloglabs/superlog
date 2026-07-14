// Talking to the bot outside an incident: a Slack @-mention (or DM) opens an
// agent chat — a durable provider session that answers questions about the
// project's code and telemetry. One chat per Slack thread (per channel for
// DMs); replies in the thread continue the same session, no re-mention needed.
//
// This module is the routing seam shared by the API (Slack events) and the
// worker (chat tick): pure decision helpers plus the race-safe record path.
// It deliberately mirrors agent-follow-up.ts — same pending-marker and
// dedupe-key idioms — but chats are their own aggregate, not incidents.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";
import type { AgentChatState } from "./schema.js";

// --- mention parsing --------------------------------------------------------

// Slack encodes mentions as <@U123> or <@U123|label> in message text.
function mentionPattern(botUserId: string): RegExp {
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<@${escaped}(\\|[^>]*)?>`, "g");
}

export function mentionsBot(text: string, botUserId: string | null): boolean {
  if (!botUserId) return false;
  return mentionPattern(botUserId).test(text);
}

export function stripBotMention(text: string, botUserId: string | null): string {
  if (!botUserId) return text.trim();
  return text.replace(mentionPattern(botUserId), " ").replace(/\s+/g, " ").trim();
}

// --- workspace → project resolution ----------------------------------------

export type ChatInstallationCandidate = {
  id: string;
  projectId: string;
  // The project's routed incident channel, if configured.
  channelId: string | null;
  isDefaultChatProject: boolean;
  installedAt: Date | null;
  createdAt: Date;
};

export type ChatInstallationResolution =
  | { outcome: "resolved"; installation: ChatInstallationCandidate }
  | { outcome: "ambiguous" }
  | { outcome: "none" };

// Pick which project answers a mention when a workspace is connected to
// several. Callers pass the team's non-revoked installations. Order:
// the install routed to the mention's channel, else the workspace's only
// install, else the flagged default-chat project, else ambiguous (the caller
// should ask the user rather than guess). Ties inside a bucket prefer the
// flagged default, then token recency (`coalesce(installedAt, createdAt)`,
// the row most likely to hold the live bot token).
export function resolveChatInstallation(
  installations: ChatInstallationCandidate[],
  channelId: string,
): ChatInstallationResolution {
  if (installations.length === 0) return { outcome: "none" };
  if (installations.length === 1) {
    const only = installations[0];
    if (!only) return { outcome: "none" };
    return { outcome: "resolved", installation: only };
  }

  const channelMatches = installations.filter((i) => i.channelId === channelId);
  if (channelMatches.length > 0) {
    return { outcome: "resolved", installation: preferFlaggedThenRecent(channelMatches) };
  }

  const flagged = installations.filter((i) => i.isDefaultChatProject);
  if (flagged.length > 0) {
    return { outcome: "resolved", installation: preferFlaggedThenRecent(flagged) };
  }

  return { outcome: "ambiguous" };
}

function preferFlaggedThenRecent(rows: ChatInstallationCandidate[]): ChatInstallationCandidate {
  const pool = rows.some((r) => r.isDefaultChatProject)
    ? rows.filter((r) => r.isDefaultChatProject)
    : rows;
  const sorted = [...pool].sort(
    (a, b) => (b.installedAt ?? b.createdAt).getTime() - (a.installedAt ?? a.createdAt).getTime(),
  );
  const winner = sorted[0];
  if (!winner) throw new Error("preferFlaggedThenRecent called with no rows");
  return winner;
}

// --- inbound routing --------------------------------------------------------

export type ChatInboundInput = {
  chatEnabled: boolean;
  existingChat: { id: string; state: AgentChatState } | null;
};

export type ChatInboundVerdict =
  | { action: "create" }
  | { action: "append"; chatId: string; requeue: boolean }
  | { action: "skip"; reason: "chat_disabled" };

// Route an inbound Slack message for a chat anchor. Pure — the record path
// below performs the writes. `requeue` marks chats the worker must pick back
// up (idle: waiting for a human; failed: a new message retries).
export function decideChatInbound(input: ChatInboundInput): ChatInboundVerdict {
  if (!input.chatEnabled) return { action: "skip", reason: "chat_disabled" };
  const chat = input.existingChat;
  if (!chat) return { action: "create" };
  const requeue = chat.state === "idle" || chat.state === "failed";
  return { action: "append", chatId: chat.id, requeue };
}

// --- persistence ------------------------------------------------------------

const CHAT_TITLE_MAX = 200;

export type RecordInboundChatMessageArgs = {
  // Resolved by the caller from the Slack installation.
  projectId: string;
  slackInstallationId: string;
  slackTeamId: string;
  slackChannelId: string;
  // Null for DMs: the whole DM channel is one conversation.
  slackThreadTs: string | null;
  authorSlackUserId: string | null;
  // Mention already stripped.
  text: string;
  slackMessageTs: string | null;
  // Keyed on (channel, ts) — NOT the Slack event id — so the app_mention and
  // message events Slack sends for one mention dedupe against each other.
  dedupeKey: string;
  now?: Date;
};

export type RecordInboundChatMessageResult =
  | { outcome: "accepted"; chatId: string; created: boolean }
  | { outcome: "duplicate" }
  | { outcome: "skipped"; reason: "chat_disabled" | "project_not_found" };

// Team id is part of the anchor: Slack ids are only guaranteed unique within
// a workspace, and a cross-workspace collision here would route one tenant's
// messages into another tenant's chat.
export async function findChatByAnchor(
  db: DB,
  teamId: string,
  channelId: string,
  threadTs: string | null,
): Promise<schema.AgentChat | null> {
  const chat = await db.query.agentChats.findFirst({
    where: threadTs
      ? and(
          eq(schema.agentChats.slackTeamId, teamId),
          eq(schema.agentChats.slackChannelId, channelId),
          eq(schema.agentChats.slackThreadTs, threadTs),
        )
      : and(
          eq(schema.agentChats.slackTeamId, teamId),
          eq(schema.agentChats.slackChannelId, channelId),
          isNull(schema.agentChats.slackThreadTs),
        ),
  });
  return chat ?? null;
}

// The shared inbound path: find-or-create the chat for the thread anchor,
// insert the message (deduped), and re-queue a dormant chat. Race-safe:
// concurrent creates collapse onto the partial unique anchor indexes, and
// the message insert's (chatId, dedupeKey) conflict absorbs Events API
// retries and app_mention/message double delivery.
export async function recordInboundChatMessage(
  db: DB,
  args: RecordInboundChatMessageArgs,
): Promise<RecordInboundChatMessageResult> {
  const now = args.now ?? new Date();

  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, args.projectId),
    columns: { id: true },
  });
  if (!project) return { outcome: "skipped", reason: "project_not_found" };

  const automation = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, args.projectId),
    columns: { chatEnabled: true, agentRunProvider: true },
  });

  let chat = await findChatByAnchor(db, args.slackTeamId, args.slackChannelId, args.slackThreadTs);

  const verdict = decideChatInbound({
    chatEnabled: automation?.chatEnabled ?? true,
    existingChat: chat ? { id: chat.id, state: chat.state } : null,
  });
  if (verdict.action === "skip") return { outcome: "skipped", reason: verdict.reason };

  let created = false;
  if (verdict.action === "create") {
    const inserted = await insertChatForAnchor(db, args, automation?.agentRunProvider);
    if (inserted) {
      chat = inserted;
      created = true;
    } else {
      // Lost the anchor race to a concurrent event — adopt the winner.
      chat = await findChatByAnchor(db, args.slackTeamId, args.slackChannelId, args.slackThreadTs);
    }
  }
  if (!chat) throw new Error("agent chat anchor row missing after insert");

  const [recorded] = await db
    .insert(schema.agentChatMessages)
    .values({
      chatId: chat.id,
      authorSlackUserId: args.authorSlackUserId,
      text: args.text,
      slackMessageTs: args.slackMessageTs,
      dedupeKey: args.dedupeKey,
    })
    .onConflictDoNothing({
      target: [schema.agentChatMessages.chatId, schema.agentChatMessages.dedupeKey],
    })
    .returning({ id: schema.agentChatMessages.id });
  if (!recorded) return { outcome: "duplicate" };

  if (verdict.action === "append" && verdict.requeue) {
    // State-guarded so a concurrent tick that already moved the chat keeps
    // its transition; the pending message row alone is enough for the next
    // sync to deliver it into the session.
    await db
      .update(schema.agentChats)
      .set({ state: "queued", failureReason: null, updatedAt: now })
      .where(
        and(
          eq(schema.agentChats.id, chat.id),
          inArray(schema.agentChats.state, ["idle", "failed"]),
        ),
      );
  } else {
    await db
      .update(schema.agentChats)
      .set({ updatedAt: now })
      .where(eq(schema.agentChats.id, chat.id));
  }

  return { outcome: "accepted", chatId: chat.id, created };
}

async function insertChatForAnchor(
  db: DB,
  args: RecordInboundChatMessageArgs,
  runtime: string | undefined,
): Promise<schema.AgentChat | null> {
  const values = {
    projectId: args.projectId,
    provider: "slack" as const,
    slackInstallationId: args.slackInstallationId,
    slackTeamId: args.slackTeamId,
    slackChannelId: args.slackChannelId,
    slackThreadTs: args.slackThreadTs,
    createdBySlackUserId: args.authorSlackUserId,
    title: args.text.slice(0, CHAT_TITLE_MAX),
    ...(runtime ? { runtime } : {}),
  };
  // The anchor indexes are partial, so the conflict target must repeat the
  // predicate for Postgres to bind ON CONFLICT to them (same lesson as
  // incident_events_dedupe_idx).
  const [inserted] = args.slackThreadTs
    ? await db
        .insert(schema.agentChats)
        .values(values)
        .onConflictDoNothing({
          target: [
            schema.agentChats.slackTeamId,
            schema.agentChats.slackChannelId,
            schema.agentChats.slackThreadTs,
          ],
          where: sql`${schema.agentChats.provider} = 'slack' and ${schema.agentChats.slackThreadTs} is not null`,
        })
        .returning()
    : await db
        .insert(schema.agentChats)
        .values(values)
        .onConflictDoNothing({
          target: [schema.agentChats.slackTeamId, schema.agentChats.slackChannelId],
          where: sql`${schema.agentChats.provider} = 'slack' and ${schema.agentChats.slackThreadTs} is null`,
        })
        .returning();
  return inserted ?? null;
}

export type RecordInboundLinearChatMessageArgs = {
  projectId: string;
  installationId: string;
  agentSessionId: string;
  issueId: string;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  issueUrl?: string | null;
  authorLinearUserId: string | null;
  text: string;
  activityId: string;
  now?: Date;
};

export async function findLinearChatSession(
  db: DB,
  installationId: string,
  agentSessionId: string,
): Promise<{ session: schema.LinearAgentSession; chat: schema.AgentChat } | null> {
  const session = await db.query.linearAgentSessions.findFirst({
    where: and(
      eq(schema.linearAgentSessions.installationId, installationId),
      eq(schema.linearAgentSessions.agentSessionId, agentSessionId),
      eq(schema.linearAgentSessions.kind, "chat"),
    ),
  });
  if (!session?.agentChatId) return null;
  const chat = await db.query.agentChats.findFirst({
    where: eq(schema.agentChats.id, session.agentChatId),
  });
  return chat ? { session, chat } : null;
}

// Linear mentions use the same durable chat aggregate as Slack while keeping
// provider payloads out of the domain. The AgentSession mapping is the
// anti-corruption layer and the provider activity id is the retry key.
export async function recordInboundLinearChatMessage(
  db: DB,
  args: RecordInboundLinearChatMessageArgs,
): Promise<RecordInboundChatMessageResult> {
  const now = args.now ?? new Date();
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, args.projectId),
    columns: { id: true },
  });
  if (!project) return { outcome: "skipped", reason: "project_not_found" };
  const automation = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, args.projectId),
    columns: { chatEnabled: true, agentRunProvider: true },
  });

  let owned = await findLinearChatSession(db, args.installationId, args.agentSessionId);
  const verdict = decideChatInbound({
    chatEnabled: automation?.chatEnabled ?? true,
    existingChat: owned ? { id: owned.chat.id, state: owned.chat.state } : null,
  });
  if (verdict.action === "skip") return { outcome: "skipped", reason: verdict.reason };

  let created = false;
  if (!owned) {
    try {
      owned = await db.transaction(async (tx) => {
        const [chat] = await tx
          .insert(schema.agentChats)
          .values({
            projectId: args.projectId,
            provider: "linear",
            slackInstallationId: null,
            slackTeamId: null,
            slackChannelId: null,
            slackThreadTs: null,
            createdByLinearUserId: args.authorLinearUserId,
            title: (args.issueTitle ?? args.text).slice(0, CHAT_TITLE_MAX),
            ...(automation?.agentRunProvider ? { runtime: automation.agentRunProvider } : {}),
          })
          .returning();
        if (!chat) throw new Error("failed to create Linear agent chat");
        const [session] = await tx
          .insert(schema.linearAgentSessions)
          .values({
            installationId: args.installationId,
            agentSessionId: args.agentSessionId,
            kind: "chat",
            issueId: args.issueId,
            issueIdentifier: args.issueIdentifier ?? null,
            issueTitle: args.issueTitle ?? null,
            issueUrl: args.issueUrl ?? null,
            agentChatId: chat.id,
          })
          .returning();
        if (!session) throw new Error("failed to map Linear agent chat");
        return { session, chat };
      });
      created = true;
    } catch (err) {
      const code =
        (err as { code?: string; cause?: { code?: string } }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code !== "23505") throw err;
      owned = await findLinearChatSession(db, args.installationId, args.agentSessionId);
    }
  }
  if (!owned) throw new Error("Linear agent chat missing after insert");

  const [recorded] = await db
    .insert(schema.agentChatMessages)
    .values({
      chatId: owned.chat.id,
      authorLinearUserId: args.authorLinearUserId,
      text: args.text,
      dedupeKey: `linear:${args.activityId}`,
    })
    .onConflictDoNothing({
      target: [schema.agentChatMessages.chatId, schema.agentChatMessages.dedupeKey],
    })
    .returning({ id: schema.agentChatMessages.id });
  if (!recorded) return { outcome: "duplicate" };

  if (verdict.action === "append" && verdict.requeue) {
    await db
      .update(schema.agentChats)
      .set({ state: "queued", failureReason: null, updatedAt: now })
      .where(
        and(
          eq(schema.agentChats.id, owned.chat.id),
          inArray(schema.agentChats.state, ["idle", "failed"]),
        ),
      );
  } else {
    await db
      .update(schema.agentChats)
      .set({ updatedAt: now })
      .where(eq(schema.agentChats.id, owned.chat.id));
  }
  return { outcome: "accepted", chatId: owned.chat.id, created };
}

// --- worker-side helpers ----------------------------------------------------

// Pending inbound messages for a chat, oldest first. The worker delivers
// them into the provider session and stamps processedAt afterwards, so a
// failed resume/steer retries on the next tick instead of dropping text.
export async function listPendingChatMessages(
  db: DB,
  chatId: string,
): Promise<schema.AgentChatMessage[]> {
  return db.query.agentChatMessages.findMany({
    where: and(
      eq(schema.agentChatMessages.chatId, chatId),
      isNull(schema.agentChatMessages.processedAt),
    ),
    orderBy: [schema.agentChatMessages.createdAt],
  });
}

export async function markChatMessagesProcessed(
  db: DB,
  messageIds: string[],
  now: Date = new Date(),
): Promise<void> {
  if (messageIds.length === 0) return;
  await db
    .update(schema.agentChatMessages)
    .set({ processedAt: now })
    .where(inArray(schema.agentChatMessages.id, messageIds));
}

// Active chats for the worker tick, oldest-updated first (same starvation
// guard as the agent-runs tick).
export async function listActiveAgentChats(db: DB, limit: number): Promise<schema.AgentChat[]> {
  return db.query.agentChats.findMany({
    where: inArray(schema.agentChats.state, ["queued", "running"]),
    orderBy: [schema.agentChats.updatedAt],
    limit,
  });
}
