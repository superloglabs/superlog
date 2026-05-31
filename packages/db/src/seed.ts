import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { generateApiKey } from "./keys.js";
import { apiKeys, orgs, projects } from "./schema.js";

const ORG_SLUG = "dev";
const PROJECT_SLUG = "dev";
const KEY_NAME = "dev-seed";

async function main() {
  const org =
    (await db.query.orgs.findFirst({ where: eq(orgs.slug, ORG_SLUG) })) ??
    (await db.insert(orgs).values({ name: "Dev Org", slug: ORG_SLUG }).returning())[0];
  if (!org) throw new Error("failed to create org");

  const project =
    (await db.query.projects.findFirst({ where: eq(projects.slug, PROJECT_SLUG) })) ??
    (
      await db
        .insert(projects)
        .values({ orgId: org.id, name: "Dev Project", slug: PROJECT_SLUG })
        .returning()
    )[0];
  if (!project) throw new Error("failed to create project");

  const { plaintext, hash, prefix } = generateApiKey();
  await db.insert(apiKeys).values({
    projectId: project.id,
    name: KEY_NAME,
    keyPrefix: prefix,
    keyHash: hash,
  });

  console.log("seeded dev org + project + api key");
  console.log(`  org.id:     ${org.id}`);
  console.log(`  project.id: ${project.id}`);
  console.log(`  api key:    ${plaintext}`);
  console.log("store the key now — it will not be shown again.");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
