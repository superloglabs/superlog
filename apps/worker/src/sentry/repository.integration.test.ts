import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type DB, schema } from "@superlog/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createDrizzleSentryIssueIngestRepository } from "./repository.js";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/migrations",
);

test("preparing a retried webhook preserves its original issue transition", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });

  try {
    const [org] = await db
      .insert(schema.orgs)
      .values({ name: "Acme", slug: "sentry-retry-acme" })
      .returning();
    assert.ok(org);
    const [project] = await db
      .insert(schema.projects)
      .values({ orgId: org.id, name: "Storefront", slug: "storefront" })
      .returning();
    assert.ok(project);
    const [installation] = await db
      .insert(schema.sentryInstallations)
      .values({
        projectId: project.id,
        sentryInstallationId: "installation-1",
        organizationSlug: "acme",
        sentryProjectSlug: "storefront",
        accessTokenCiphertext: Buffer.from("encrypted-access-token"),
        accessTokenNonce: "access-nonce",
        relayTokenCiphertext: Buffer.from("encrypted-relay-token"),
        relayTokenNonce: "relay-nonce",
      })
      .returning();
    assert.ok(installation);
    const [event] = await db
      .insert(schema.sentryWebhookEvents)
      .values({
        installationId: installation.id,
        dedupeKey: "event-1",
        action: "created",
        sentryIssueId: "42",
        title: "Checkout failed",
        rawPayload: {},
      })
      .returning();
    assert.ok(event);

    const repository = createDrizzleSentryIssueIngestRepository(db);
    const occurrence = {
      action: "created" as const,
      projectId: project.id,
      fingerprint: "sentry:acme:42",
      title: "Checkout failed",
      exceptionType: "SentryIssue",
      service: "storefront",
      message: "checkout.submit",
      severity: "error",
      firstSeen: new Date("2026-07-21T11:00:00.000Z"),
      lastSeen: new Date("2026-07-21T11:00:00.000Z"),
      eventCount: 1,
      resourceAttrs: { "sentry.issue.id": "42" },
    };

    const first = await repository.prepareIssue(event.id, occurrence);
    const retry = await repository.prepareIssue(event.id, occurrence);

    assert.equal(first.transition, "new");
    assert.equal(retry.transition, "new");
    assert.equal(retry.issue?.id, first.issue?.id);
    const stored = await db.query.sentryWebhookEvents.findFirst({
      where: (table, { eq }) => eq(table.id, event.id),
    });
    assert.equal(stored?.transition, "new");
    assert.equal(stored?.issueId, first.issue?.id);
  } finally {
    await client.close();
  }
});
