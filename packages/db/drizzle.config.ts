import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// Resolve DATABASE_URL with this precedence:
//   1. process.env (explicit caller override always wins)
//   2. <repo-root>/tmp/worktree.json (written by worktree-bootstrap.sh)
//   3. <repo-root>/apps/api/.env.local (port-offset shared mode)
//   4. packages/db/.env (self-host path — copy .env.example here)
//
// The worktree sources must stay ahead of the self-host fallback so a worktree
// that also has a packages/db/.env keeps targeting its own database. Without
// any of these, `pnpm --filter @superlog/db db:migrate` — e.g. during
// self-hosting per docs.superlog.sh/self-hosting after `docker compose up -d` —
// fails with "Please provide required params for Postgres driver: url: ''".
// The self-host instructions create Postgres on port 5434, so pull the URL from
// this package's local .env file when no other source is available.
function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== "/") {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  return start;
}

const ROOT = findRepoRoot(resolve(process.cwd()));

// Safely parse a DATABASE_URL= line from an env-style file: tolerate
// whitespace around "=", strip surrounding single/double quotes, and drop
// any trailing inline comment.
function readDatabaseUrlFromEnvFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const m = readFileSync(path, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
  if (!m) return undefined;
  const v = m[1].trim().split(/\s+#/)[0].replace(/^['"]|['"]$/g, "").trim();
  return v || undefined;
}

const DB_PACKAGE_ENV = join(ROOT, "packages", "db", ".env");

function readDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const summary = join(ROOT, "tmp", "worktree.json");
  if (existsSync(summary)) {
    try {
      const j = JSON.parse(readFileSync(summary, "utf8"));
      if (typeof j.database_url === "string") return j.database_url;
    } catch {
      // fall through
    }
  }

  const envLocal = readDatabaseUrlFromEnvFile(join(ROOT, "apps", "api", ".env.local"));
  if (envLocal) return envLocal;

  const selfHost = readDatabaseUrlFromEnvFile(DB_PACKAGE_ENV);
  if (selfHost) return selfHost;

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
