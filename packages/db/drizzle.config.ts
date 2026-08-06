import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// Resolve DATABASE_URL with this precedence:
//   1. process.env (explicit caller override always wins)
//   2. <repo-root>/tmp/worktree.json (written by worktree-bootstrap.sh)
//   3. <repo-root>/apps/api/.env.local (port-offset shared mode)
//
// Without this, `pnpm --filter @superlog/db db:migrate` run by hand from a
// worktree fails with "Please provide required params for Postgres driver:
// url: ''". The bootstrap script inlines DATABASE_URL when it runs migrate
// itself, so historically only manual reruns hit this.
function findRepoRoot(start: string): string {
  let dir = start;

  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;

    const parent = dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  return start;
}

function readDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const root = findRepoRoot(resolve(process.cwd()));

  const summary = join(root, "tmp", "worktree.json");
  if (existsSync(summary)) {
    try {
      const j = JSON.parse(readFileSync(summary, "utf8"));
      if (typeof j.database_url === "string") return j.database_url;
    } catch {
      // fall through
    }
  }

  const envLocal = join(root, "apps", "api", ".env.local");
  if (existsSync(envLocal)) {
    const m = readFileSync(envLocal, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }

  return "";
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: readDatabaseUrl(),
  },
});
