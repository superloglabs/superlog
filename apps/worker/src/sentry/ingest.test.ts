import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import { type SentryIssueIngestRepository, createSentryIssueIngestor } from "./ingest.js";

test("a pending new Sentry issue enters the shared issue transition workflow", async () => {
  const event = {
    id: "event-1",
    projectId: "project-1",
    organizationSlug: "acme",
    sentryProjectSlug: "storefront",
    action: "created" as const,
    sentryIssueId: "42",
    title: "Checkout failed",
    culprit: "checkout.submit",
    level: "error",
    firstSeen: new Date("2026-07-21T11:00:00.000Z"),
    lastSeen: new Date("2026-07-21T11:00:00.000Z"),
    eventCount: 1,
    issueUrl: "https://acme.sentry.io/issues/42/",
  };
  const issue = { id: "local-issue-1", projectId: event.projectId } as schema.Issue;
  const processed: string[] = [];
  const repository: SentryIssueIngestRepository = {
    claimPending: async () => [event],
    prepareIssue: async (_eventId, occurrence) => {
      assert.deepEqual(occurrence, {
        action: "created",
        projectId: "project-1",
        fingerprint: "sentry:acme:42",
        title: "Checkout failed",
        exceptionType: "SentryIssue",
        service: "storefront",
        message: "checkout.submit",
        severity: "error",
        firstSeen: event.firstSeen,
        lastSeen: event.lastSeen,
        eventCount: 1,
        resourceAttrs: {
          "sentry.organization.slug": "acme",
          "sentry.project.slug": "storefront",
          "sentry.issue.id": "42",
          "sentry.issue.url": "https://acme.sentry.io/issues/42/",
        },
      });
      return { transition: "new", issue };
    },
    markProcessed: async (id) => {
      processed.push(id);
    },
    markFailed: async () => {
      assert.fail("successful events must not be marked failed");
    },
  };
  const transitions: Array<{ issue: schema.Issue; transition: "new" | "recurred" }> = [];
  const ingestor = createSentryIssueIngestor({
    repository,
    handleIssueTransition: async (transitionIssue, transition) => {
      transitions.push({ issue: transitionIssue, transition });
    },
  });

  assert.equal(await ingestor.tick(), 1);
  assert.deepEqual(transitions, [{ issue, transition: "new" }]);
  assert.deepEqual(processed, ["event-1"]);
});

test("a failed transition handler retries the original Sentry transition", async () => {
  const event = {
    id: "event-1",
    projectId: "project-1",
    organizationSlug: "acme",
    sentryProjectSlug: "storefront",
    action: "created" as const,
    sentryIssueId: "42",
    title: "Checkout failed",
    culprit: "checkout.submit",
    level: "error",
    firstSeen: new Date("2026-07-21T11:00:00.000Z"),
    lastSeen: new Date("2026-07-21T11:00:00.000Z"),
    eventCount: 1,
    issueUrl: "https://acme.sentry.io/issues/42/",
  };
  const issue = { id: "local-issue-1", projectId: event.projectId } as schema.Issue;
  let preparedTransition: { transition: "new"; issue: schema.Issue } | null = null;
  let processed = 0;
  let failed = 0;
  const repository: SentryIssueIngestRepository = {
    claimPending: async () => (processed === 0 ? [event] : []),
    prepareIssue: async () => {
      preparedTransition ??= { transition: "new", issue };
      return preparedTransition;
    },
    markProcessed: async () => {
      processed += 1;
    },
    markFailed: async () => {
      failed += 1;
    },
  };
  const transitions: string[] = [];
  const ingestor = createSentryIssueIngestor({
    repository,
    handleIssueTransition: async (_transitionIssue, transition) => {
      transitions.push(transition);
      if (transitions.length === 1) throw new Error("temporary transition failure");
    },
  });

  assert.equal(await ingestor.tick(), 0);
  assert.equal(await ingestor.tick(), 1);
  assert.deepEqual(transitions, ["new", "new"]);
  assert.equal(failed, 1);
  assert.equal(processed, 1);
});
