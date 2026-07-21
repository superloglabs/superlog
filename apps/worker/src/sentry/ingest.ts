import type { schema } from "@superlog/db";

export type PendingSentryIssueEvent = {
  id: string;
  projectId: string;
  organizationSlug: string;
  sentryProjectSlug: string;
  action: "created" | "unresolved";
  sentryIssueId: string;
  title: string;
  culprit: string | null;
  level: string | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  eventCount: number;
  issueUrl: string | null;
};

export type SentryIssueOccurrence = {
  action: "created" | "unresolved";
  projectId: string;
  fingerprint: string;
  title: string;
  exceptionType: string;
  service: string;
  message: string | null;
  severity: string | null;
  firstSeen: Date;
  lastSeen: Date;
  eventCount: number;
  resourceAttrs: Record<string, string>;
};

type IssueTransition = "new" | "recurred" | "suppressed" | "seen";

export type SentryIssueIngestRepository = {
  claimPending(limit: number): Promise<PendingSentryIssueEvent[]>;
  upsertIssue(
    occurrence: SentryIssueOccurrence,
  ): Promise<{ transition: IssueTransition; issue: schema.Issue | null }>;
  markProcessed(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string): Promise<void>;
};

export type SentryIssueIngestor = {
  tick(): Promise<number>;
};

export function createSentryIssueIngestor(input: {
  repository: SentryIssueIngestRepository;
  handleIssueTransition: (issue: schema.Issue, transition: "new" | "recurred") => Promise<void>;
  batchSize?: number;
  now?: () => Date;
}): SentryIssueIngestor {
  const batchSize = input.batchSize ?? 100;
  const now = input.now ?? (() => new Date());
  return {
    async tick() {
      const events = await input.repository.claimPending(batchSize);
      let processed = 0;
      for (const event of events) {
        try {
          const result = await input.repository.upsertIssue(toOccurrence(event, now()));
          if ((result.transition === "new" || result.transition === "recurred") && result.issue) {
            await input.handleIssueTransition(result.issue, result.transition);
          }
          await input.repository.markProcessed(event.id);
          processed += 1;
        } catch (error) {
          await input.repository.markFailed(
            event.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return processed;
    },
  };
}

function toOccurrence(event: PendingSentryIssueEvent, fallbackSeenAt: Date): SentryIssueOccurrence {
  const resourceAttrs: Record<string, string> = {
    "sentry.organization.slug": event.organizationSlug,
    "sentry.project.slug": event.sentryProjectSlug,
    "sentry.issue.id": event.sentryIssueId,
  };
  if (event.issueUrl) resourceAttrs["sentry.issue.url"] = event.issueUrl;
  return {
    action: event.action,
    projectId: event.projectId,
    fingerprint: `sentry:${event.organizationSlug}:${event.sentryIssueId}`,
    title: event.title,
    exceptionType: "SentryIssue",
    service: event.sentryProjectSlug,
    message: event.culprit,
    severity: event.level,
    firstSeen: event.firstSeen ?? event.lastSeen ?? fallbackSeenAt,
    lastSeen: event.lastSeen ?? event.firstSeen ?? fallbackSeenAt,
    eventCount: Math.max(1, event.eventCount),
    resourceAttrs,
  };
}
