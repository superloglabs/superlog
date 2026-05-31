// Backfills `project_id` on github/slack/linear installations.
//
// Rule per install:
// - Org has exactly one project → set project_id = that project.
// - Org has multiple projects → consult the manual override map below; skip
//   anything unmapped and report it so a human picks.
//
// Existing prod data: 107 orgs are 1:1 with their project. Only Pairio
// (org 9583de0c…) has two projects (default + production); telemetry shows
// `default` (f035b6c3…) is the live one and `production` (d9181e4f…) has
// 2 spans from late April.
//
// Run against prod via Railway:
//   railway run --service Postgres pnpm tsx scripts/backfill-installations-project-id.ts
//
// Idempotent: only updates rows where project_id IS NULL.
import process from "node:process";
import { and, eq, isNull } from "drizzle-orm";

const MULTI_PROJECT_ORG_OVERRIDES: Record<string, string> = {
  // Pairio → default project (the live one; production has effectively no traffic)
  "9583de0c-6be7-4597-96b4-45c9e9743e8c": "f035b6c3-2037-4d3e-b4f9-ec66d2166cb9",
};

type InstallationTable = "github_installations" | "slack_installations" | "linear_installations";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const [{ db }, schema] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
  ]);

  // Build org → project map.
  const projects = await db.query.projects.findMany({});
  const projectsByOrg = new Map<string, string[]>();
  for (const p of projects) {
    const list = projectsByOrg.get(p.orgId) ?? [];
    list.push(p.id);
    projectsByOrg.set(p.orgId, list);
  }

  function pickProjectForOrg(orgId: string): { projectId: string | null; reason: string } {
    const candidates = projectsByOrg.get(orgId) ?? [];
    if (candidates.length === 0) {
      return { projectId: null, reason: "org has no projects" };
    }
    if (candidates.length === 1) {
      return { projectId: candidates[0]!, reason: "single project in org" };
    }
    const override = MULTI_PROJECT_ORG_OVERRIDES[orgId];
    if (override && candidates.includes(override)) {
      return { projectId: override, reason: "manual override" };
    }
    return { projectId: null, reason: `${candidates.length} projects in org, no override` };
  }

  async function backfillTable(
    table: InstallationTable,
    rows: { id: string; orgId: string; projectId: string | null }[],
  ): Promise<void> {
    let updated = 0;
    let skippedAlreadySet = 0;
    const skippedNoTarget: { id: string; orgId: string; reason: string }[] = [];

    for (const row of rows) {
      if (row.projectId) {
        skippedAlreadySet += 1;
        continue;
      }
      const { projectId, reason } = pickProjectForOrg(row.orgId);
      if (!projectId) {
        skippedNoTarget.push({ id: row.id, orgId: row.orgId, reason });
        continue;
      }
      const tableRef =
        table === "github_installations"
          ? schema.githubInstallations
          : table === "slack_installations"
            ? schema.slackInstallations
            : schema.linearInstallations;
      await db
        .update(tableRef)
        .set({ projectId })
        .where(and(eq(tableRef.id, row.id), isNull(tableRef.projectId)));
      updated += 1;
    }

    console.log(
      `${table}: updated=${updated} skipped_already_set=${skippedAlreadySet} skipped_no_target=${skippedNoTarget.length}`,
    );
    for (const s of skippedNoTarget) {
      console.log(`  needs manual mapping: ${table} id=${s.id} org=${s.orgId} (${s.reason})`);
    }
  }

  const gh = await db.query.githubInstallations.findMany({});
  await backfillTable("github_installations", gh);

  const sl = await db.query.slackInstallations.findMany({});
  await backfillTable("slack_installations", sl);

  const li = await db.query.linearInstallations.findMany({});
  await backfillTable("linear_installations", li);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
