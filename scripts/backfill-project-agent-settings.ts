// Backfills `project_automation_settings` rows for projects that don't have one.
// For each project, copies `customInstructions`/`agentRunEnabled`/policies
// from the org's `org_agent_settings` row when present; otherwise leaves the
// table defaults (auto-investigate ON, agentRun ON, on_ready_to_pr).
//
// Run against prod via Railway:
//   railway run --service Postgres pnpm tsx scripts/backfill-project-agent-settings.ts
//
// Idempotent: only inserts where no row exists; never overwrites existing rows.
import process from "node:process";
import { eq } from "drizzle-orm";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const [{ db }, schema] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
  ]);

  const projects = await db.query.projects.findMany({});
  let inserted = 0;
  let skipped = 0;

  for (const project of projects) {
    const existing = await db.query.projectAutomationSettings.findFirst({
      where: eq(schema.projectAutomationSettings.projectId, project.id),
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const orgSettings = await db.query.orgAgentSettings.findFirst({
      where: eq(schema.orgAgentSettings.orgId, project.orgId),
    });

    await db.insert(schema.projectAutomationSettings).values({
      projectId: project.id,
      customInstructions: orgSettings?.customInstructions ?? "",
      agentRunEnabled: orgSettings?.agentRunEnabled ?? true,
      linearTicketPolicy: orgSettings?.linearTicketPolicy ?? "on_ready_to_pr",
      prPolicy: orgSettings?.prPolicy ?? "on_ready_to_pr",
    });
    inserted += 1;
    console.log(`inserted automation row for project ${project.id} (${project.name})`);
  }

  console.log(`done — inserted ${inserted}, skipped ${skipped} of ${projects.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
