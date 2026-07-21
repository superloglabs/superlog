import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { createDrizzleSentryWebhookInbox } from "./repository.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const orgIds: string[] = [];

before(async () => runMigrations());
after(async () => {
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
  } finally {
    await closeDb();
  }
});

test("stores an imported issue against its selected local project", async () => {
  const tag = `sentry-repository-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: tag, slug: tag })
    .returning();
  assert.ok(org);
  orgIds.push(org.id);

  const projects = await db
    .insert(schema.projects)
    .values([
      { orgId: org.id, name: "First", slug: `${tag}-first` },
      { orgId: org.id, name: "Second", slug: `${tag}-second` },
    ])
    .returning();
  const firstProject = projects[0];
  const selectedProject = projects[1];
  assert.ok(firstProject);
  assert.ok(selectedProject);

  const installations = await db
    .insert(schema.sentryInstallations)
    .values(
      [firstProject, selectedProject].map((project) => ({
        projectId: project.id,
        sentryInstallationId: "shared-installation",
        organizationSlug: "acme",
        sentryProjectSlug: "storefront",
        accessTokenCiphertext: Buffer.from("access"),
        accessTokenNonce: "access-nonce",
        relayTokenCiphertext: Buffer.from("relay"),
        relayTokenNonce: "relay-nonce",
      })),
    )
    .returning();
  const selectedInstallation = installations.find(
    (installation) => installation.projectId === selectedProject.id,
  );
  assert.ok(selectedInstallation);

  await createDrizzleSentryWebhookInbox().save({
    action: "created",
    installationId: "shared-installation",
    targetProjectId: selectedProject.id,
    dedupeKey: `${tag}-delivery`,
    rawBody: "{}",
    rawPayload: {},
    issue: {
      id: "42",
      title: "Checkout failed",
      culprit: null,
      level: "error",
      firstSeen: null,
      lastSeen: null,
      count: 1,
      url: null,
      projectSlug: "storefront",
    },
  });

  const stored = await db.query.sentryWebhookEvents.findFirst({
    where: eq(schema.sentryWebhookEvents.dedupeKey, `${tag}-delivery`),
  });
  assert.equal(stored?.installationId, selectedInstallation.id);
});
