import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { test } from "node:test";
import { receiveSentryIssueEvent } from "./application.js";
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
