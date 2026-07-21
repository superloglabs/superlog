import { db, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import type { SentryWebhookInbox, StoredSentryIssueDelivery } from "./application.js";

export function createDrizzleSentryWebhookInbox(): SentryWebhookInbox & {
  revokeInstallation(sentryInstallationId: string): Promise<void>;
} {
  return {
    async save(delivery: StoredSentryIssueDelivery): Promise<void> {
      const installation = await db.query.sentryInstallations.findFirst({
        where: and(
          eq(schema.sentryInstallations.sentryInstallationId, delivery.installationId),
          eq(schema.sentryInstallations.sentryProjectSlug, delivery.issue.projectSlug),
          isNull(schema.sentryInstallations.revokedAt),
        ),
        columns: { id: true, sentryProjectSlug: true },
      });
      if (!installation) return;
      await db
        .insert(schema.sentryWebhookEvents)
        .values({
          installationId: installation.id,
          dedupeKey: delivery.dedupeKey,
          action: delivery.action,
          sentryIssueId: delivery.issue.id,
          title: delivery.issue.title,
          culprit: delivery.issue.culprit,
          level: delivery.issue.level,
          firstSeen: parseDate(delivery.issue.firstSeen),
          lastSeen: parseDate(delivery.issue.lastSeen),
          eventCount: delivery.issue.count,
          issueUrl: delivery.issue.url,
          rawPayload: delivery.rawPayload,
        })
        .onConflictDoNothing({ target: schema.sentryWebhookEvents.dedupeKey });
    },
    async revokeInstallation(sentryInstallationId) {
      await db
        .update(schema.sentryInstallations)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.sentryInstallations.sentryInstallationId, sentryInstallationId),
            isNull(schema.sentryInstallations.revokedAt),
          ),
        );
    },
  };
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
