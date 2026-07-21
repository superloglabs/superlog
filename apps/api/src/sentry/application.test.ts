import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { test } from "node:test";
import { importOpenSentryIssues, receiveSentryIssueEvent } from "./application.js";
import type { SentryIssueEvent } from "./domain.js";

test("stores a stable delivery key so Sentry retries are idempotent", async () => {
  const event: SentryIssueEvent = {
    action: "unresolved",
    installationId: "installation-1",
    rawBody: '{"delivery":"same"}',
    issue: {
      id: "42",
      title: "Checkout failed",
      culprit: null,
      level: "error",
      firstSeen: null,
      lastSeen: "2026-07-21T11:00:00.000Z",
      count: 2,
      url: null,
      projectSlug: "storefront",
    },
  };
  const saved: unknown[] = [];

  await receiveSentryIssueEvent(
    {
      save: async (delivery) => {
        saved.push(delivery);
      },
    },
    event,
  );

  assert.deepEqual(saved, [
    {
      ...event,
      dedupeKey: crypto.createHash("sha256").update(event.rawBody).digest("hex"),
      rawPayload: { delivery: "same" },
    },
  ]);
});

test("imports every currently open Sentry issue into the durable inbox idempotently", async () => {
  const saved: unknown[] = [];
  const imported = await importOpenSentryIssues(
    {
      listOpenIssues: async () => [
        {
          id: "42",
          title: "Checkout failed",
          culprit: "checkout.submit",
          level: "error",
          firstSeen: "2026-07-20T10:00:00.000Z",
          lastSeen: "2026-07-21T11:00:00.000Z",
          count: 7,
          url: "https://acme.sentry.io/issues/42/",
          projectSlug: "storefront",
        },
        {
          id: "99",
          title: "Worker timed out",
          culprit: null,
          level: "fatal",
          firstSeen: null,
          lastSeen: null,
          count: 1,
          url: null,
          projectSlug: "storefront",
        },
      ],
    },
    {
      save: async (delivery) => {
        saved.push(delivery);
      },
    },
    {
      accessToken: "access-token",
      organizationSlug: "acme",
      projectSlug: "storefront",
      installationId: "installation-1",
      targetProjectId: "project-1",
    },
  );

  assert.equal(imported, 2);
  assert.deepEqual(
    saved.map((delivery) => ({
      action: (delivery as { action: string }).action,
      id: (delivery as { issue: { id: string } }).issue.id,
      dedupeKey: (delivery as { dedupeKey: string }).dedupeKey,
      targetProjectId: (delivery as { targetProjectId?: string }).targetProjectId,
    })),
    [
      {
        action: "created",
        id: "42",
        targetProjectId: "project-1",
        dedupeKey: crypto
          .createHash("sha256")
          .update("sentry-open-issue:project-1:acme:storefront:42")
          .digest("hex"),
      },
      {
        action: "created",
        id: "99",
        targetProjectId: "project-1",
        dedupeKey: crypto
          .createHash("sha256")
          .update("sentry-open-issue:project-1:acme:storefront:99")
          .digest("hex"),
      },
    ],
  );
});
