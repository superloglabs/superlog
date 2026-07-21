import crypto from "node:crypto";
import type { SentryIssue, SentryIssueEvent } from "./domain.js";

export type StoredSentryIssueDelivery = SentryIssueEvent & {
  dedupeKey: string;
  rawPayload: Record<string, unknown>;
  targetProjectId?: string;
};

export type SentryWebhookInbox = {
  save(delivery: StoredSentryIssueDelivery): Promise<void>;
};

export type SentryOpenIssueSource = {
  listOpenIssues(input: {
    accessToken: string;
    organizationSlug: string;
    projectSlug: string;
  }): Promise<SentryIssue[]>;
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

export async function importOpenSentryIssues(
  source: SentryOpenIssueSource,
  inbox: SentryWebhookInbox,
  input: {
    accessToken: string;
    organizationSlug: string;
    projectSlug: string;
    installationId: string;
    targetProjectId: string;
  },
): Promise<number> {
  const issues = await source.listOpenIssues(input);
  for (const issue of issues) {
    const rawPayload = { source: "open-issue-import", issue };
    await inbox.save({
      action: "created",
      installationId: input.installationId,
      targetProjectId: input.targetProjectId,
      issue,
      rawBody: JSON.stringify(rawPayload),
      rawPayload,
      dedupeKey: crypto
        .createHash("sha256")
        .update(
          `sentry-open-issue:${input.targetProjectId}:${input.organizationSlug}:${input.projectSlug}:${issue.id}`,
        )
        .digest("hex"),
    });
  }
  return issues.length;
}
