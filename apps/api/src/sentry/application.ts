import crypto from "node:crypto";
import type { SentryIssueEvent } from "./domain.js";

export type StoredSentryIssueDelivery = SentryIssueEvent & {
  dedupeKey: string;
  rawPayload: Record<string, unknown>;
};

export type SentryWebhookInbox = {
  save(delivery: StoredSentryIssueDelivery): Promise<void>;
};

export async function receiveSentryIssueEvent(
  inbox: SentryWebhookInbox,
  event: SentryIssueEvent,
): Promise<void> {
  await inbox.save({
    ...event,
    dedupeKey: crypto.createHash("sha256").update(event.rawBody).digest("hex"),
    rawPayload: JSON.parse(event.rawBody) as Record<string, unknown>,
  });
}
