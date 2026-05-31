import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { and, eq, isNull } from "drizzle-orm";

// Walks every project in the worktree's pg, mints a fresh "onboarding"
// ingest key, and fires sample telemetry through the worktree proxy into
// any project that has zero traces yet. Idempotent: projects with traces
// already in CH are skipped, the key for those is left alone.
//
// This is what unsticks <OnboardingGate> after a user signs in with a
// Clerk org whose slug isn't `acme` — the API creates a brand-new local
// org for them, which has no telemetry until something fires into it.
// Re-running `pnpm worktree:verify` (or this script directly) discovers
// that new project and seeds it.

type Summary = {
  worktree: string;
  database_url: string;
  proxy_url: string;
  clickhouse_url?: string;
};

const SUMMARY_FILE = "tmp/worktree.json";

function chHost(summary: Summary): string {
  return summary.clickhouse_url ?? "http://localhost:8123";
}

async function chTraceCount(summary: Summary, projectId: string): Promise<number> {
  const url = `${chHost(summary)}/?database=${process.env.CLICKHOUSE_DB ?? "superlog"}`;
  const query = `SELECT count(*) FROM otel_traces WHERE ResourceAttributes['superlog.project_id'] = '${projectId}' FORMAT TabSeparated`;
  try {
    const response = await fetch(url, { method: "POST", body: query });
    if (!response.ok) return 0;
    const body = (await response.text()).trim();
    const n = Number.parseInt(body, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const summary = JSON.parse(readFileSync(SUMMARY_FILE, "utf8")) as Summary;
  process.env.DATABASE_URL = summary.database_url;

  const [{ db }, schema, keys] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
    import("../packages/db/src/keys.js"),
  ]);

  const [projects, orgs] = await Promise.all([
    db.query.projects.findMany(),
    db.query.orgs.findMany(),
  ]);
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  if (projects.length === 0) {
    console.log("  (no projects in pg — nothing to onboard)");
    return;
  }

  for (const project of projects) {
    const org = orgById.get(project.orgId);
    const label = `${org?.name ?? "?"}/${project.name}`;
    const traces = await chTraceCount(summary, project.id);
    if (traces > 0) {
      console.log(`  skip  ${label}  (${traces} traces already in CH)`);
      continue;
    }

    const keyName = `${summary.worktree}-onboard-${project.slug}`;
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.projectId, project.id),
          eq(schema.apiKeys.name, keyName),
          isNull(schema.apiKeys.revokedAt),
        ),
      );

    const minted = keys.generateApiKey();
    await db.insert(schema.apiKeys).values({
      projectId: project.id,
      name: keyName,
      keyHash: minted.hash,
      keyPrefix: minted.prefix,
    });

    console.log(`  seed  ${label}  → firing sample telemetry`);
    const result = spawnSync(
      "pnpm",
      [
        "--silent",
        "exec",
        "tsx",
        "scripts/demo/seed-acme-telemetry.ts",
        "--ingest-url",
        summary.proxy_url,
        "--api-key",
        minted.plaintext,
      ],
      {
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS:
            process.env.NODE_EXTRA_CA_CERTS ?? `${process.env.HOME}/.portless/ca.pem`,
        },
      },
    );
    if (result.status !== 0) {
      console.error(`  warn  seed failed for ${label} (exit ${result.status})`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
