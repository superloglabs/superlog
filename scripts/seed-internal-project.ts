// Provisions the org + project + ingest API key that the superlog services
// (api/proxy/worker) use to dogfood their own telemetry into the local stack.
//
//   DATABASE_URL=postgres://postgres:postgres@localhost:5434/superlog \
//     pnpm tsx scripts/seed-internal-project.ts
//
// Idempotent on (org_slug, project_slug). Always mints a fresh API key and
// revokes any prior key with the same name — there's no way to recover the
// plaintext of an existing key, so the script is the source of truth.
import process from "node:process";
import { and, eq, isNull } from "drizzle-orm";

const ORG_SLUG = "superlog-internal";
const ORG_NAME = "Superlog Internal";
const PROJECT_SLUG = "superlog-internal";
const PROJECT_NAME = "Superlog Internal";
const KEY_NAME = "superlog-internal-ingest";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const [{ db }, schema, keys] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
    import("../packages/db/src/keys.js"),
  ]);

  const existingOrg = await db.query.orgs.findFirst({
    where: eq(schema.orgs.slug, ORG_SLUG),
  });
  const org =
    existingOrg ??
    (
      await db
        .insert(schema.orgs)
        .values({ name: ORG_NAME, slug: ORG_SLUG })
        .returning()
    )[0];
  if (!org) throw new Error("failed to provision org");

  const existingProject = await db.query.projects.findFirst({
    where: and(
      eq(schema.projects.orgId, org.id),
      eq(schema.projects.slug, PROJECT_SLUG),
    ),
  });
  const project =
    existingProject ??
    (
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: PROJECT_NAME, slug: PROJECT_SLUG })
        .returning()
    )[0];
  if (!project) throw new Error("failed to provision project");

  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.apiKeys.projectId, project.id),
        eq(schema.apiKeys.name, KEY_NAME),
        isNull(schema.apiKeys.revokedAt),
      ),
    );

  const { plaintext, hash, prefix } = keys.generateApiKey();
  const inserted = await db
    .insert(schema.apiKeys)
    .values({
      projectId: project.id,
      name: KEY_NAME,
      keyHash: hash,
      keyPrefix: prefix,
    })
    .returning();
  const apiKey = inserted[0];
  if (!apiKey) throw new Error("failed to create api key");

  console.log(
    JSON.stringify(
      {
        org: { id: org.id, slug: org.slug },
        project: { id: project.id, slug: project.slug },
        apiKey: { id: apiKey.id, name: apiKey.name, prefix: apiKey.keyPrefix, plaintext },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
