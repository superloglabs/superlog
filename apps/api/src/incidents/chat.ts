import type { AgentRunFollowUpInteraction } from "@superlog/db";

// Message cap matches the other human channels' practical sizes (a Slack
// message tops out at 4k characters); it exists to keep a pasted log dump from
// blowing up the follow-up prompt.
export const INCIDENT_CHAT_MAX_LENGTH = 4000;

// The client generates the message id (a uuid) so retries of the same send are
// idempotent end-to-end — the id becomes the dedupe key recordInboundInteraction
// guards on, mirroring Slack's event_id and GitHub's comment id.
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type PreparedIncidentChatMessage =
  | { ok: true; interaction: AgentRunFollowUpInteraction; dedupeKey: string }
  | { ok: false; error: "empty_message" | "message_too_long" | "invalid_message_id" };

// Validate a web chat message and shape it into the shared follow-up
// interaction. Pure — the route feeds the result to recordInboundInteraction.
export function prepareIncidentChatMessage(args: {
  text: string;
  messageId: string;
  author: string | null;
  now: Date;
}): PreparedIncidentChatMessage {
  const text = args.text.trim();
  if (!text) return { ok: false, error: "empty_message" };
  if (text.length > INCIDENT_CHAT_MAX_LENGTH) return { ok: false, error: "message_too_long" };
  if (!MESSAGE_ID_RE.test(args.messageId)) return { ok: false, error: "invalid_message_id" };
  return {
    ok: true,
    interaction: {
      channel: "web_chat",
      author: args.author,
      text,
      occurredAt: args.now.toISOString(),
    },
    dedupeKey: `web_chat:${args.messageId}`,
  };
}
