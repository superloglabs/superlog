// Sets commit_author_* for a GitHub installation by picking the most recent
// non-bot committer on an enabled repo's default branch. Used to populate
// commit identity for installs that happened before the install-time OAuth
// capture was wired up.
//
// Usage:
//   pnpm tsx scripts/backfill-commit-author-from-repo.ts <accountLogin> --dry-run
//   pnpm tsx scripts/backfill-commit-author-from-repo.ts <accountLogin> --apply
//
// Against prod, run via Railway so DATABASE_URL + GITHUB_APP_* come from there:
//   railway run --service api pnpm tsx scripts/backfill-commit-author-from-repo.ts ontora --dry-run
//   railway run --service api pnpm tsx scripts/backfill-commit-author-from-repo.ts ontora --apply
import crypto from "node:crypto";
import process from "node:process";
import { eq } from "drizzle-orm";

const GITHUB_API = "https://api.github.com";

type StoredRepo = { id: number; fullName: string; private: boolean };
type GhCommit = {
  sha: string;
  commit: { author: { name?: string; email?: string; date?: string } | null };
  author: { login?: string; id?: number; type?: string; avatar_url?: string | null } | null;
};

function signJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-backfill",
    },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const accountLogin = process.argv[2];
  if (!accountLogin || accountLogin.startsWith("--")) {
    console.error("usage: backfill-commit-author-from-repo.ts <accountLogin> [--dry-run|--apply]");
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");
  const dry = process.argv.includes("--dry-run") || !apply;

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey =
    process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
    (process.env.GITHUB_APP_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8")
      : undefined);
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID + private key required");

  const [{ db }, schema] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
  ]);

  const installs = await db.query.githubInstallations.findMany({
    where: eq(schema.githubInstallations.accountLogin, accountLogin),
  });
  if (installs.length === 0) {
    throw new Error(`no githubInstallations row found with accountLogin=${accountLogin}`);
  }
  if (installs.length > 1) {
    console.warn(`found ${installs.length} installations for ${accountLogin}; updating all`);
  }

  const jwt = signJwt(appId, privateKey);

  for (const install of installs) {
    console.log(`\n→ installation ${install.installationId} (org ${install.orgId})`);
    if (install.commitAuthorEmail) {
      console.log(`  already has commit author ${install.commitAuthorEmail} — skipping`);
      continue;
    }

    // Mint installation token.
    const tokenRes = await fetch(
      `${GITHUB_API}/app/installations/${install.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "superlog-backfill",
        },
        body: JSON.stringify({ permissions: { contents: "read", metadata: "read" } }),
      },
    );
    if (!tokenRes.ok) {
      throw new Error(`token mint failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const { token } = (await tokenRes.json()) as { token: string };

    const repos = (install.repos ?? []) as StoredRepo[];
    const disabled = new Set(
      ((install.repoAccess as { disabledRepoIds?: number[] } | null)?.disabledRepoIds ?? []),
    );
    const enabledRepos = repos.filter((r) => !disabled.has(r.id));
    if (enabledRepos.length === 0) {
      console.log("  no enabled repos — skipping");
      continue;
    }

    let picked: { author: GhCommit["author"]; commit: NonNullable<GhCommit["commit"]["author"]> } | null = null;
    let pickedRepo: string | null = null;

    for (const repo of enabledRepos) {
      try {
        const commits = await gh<GhCommit[]>(
          `/repos/${repo.fullName}/commits?per_page=30`,
          token,
        );
        // Prefer non-bot user with non-noreply email.
        const real = commits.find(
          (c) =>
            c.author?.type === "User" &&
            c.author.login &&
            !c.author.login.endsWith("[bot]") &&
            c.commit.author?.email &&
            c.commit.author?.name &&
            !c.commit.author.email.endsWith("@users.noreply.github.com"),
        );
        const fallback = commits.find(
          (c) =>
            c.author?.type === "User" &&
            c.author.login &&
            !c.author.login.endsWith("[bot]") &&
            c.commit.author?.email &&
            c.commit.author?.name,
        );
        const chosen = real ?? fallback;
        if (chosen?.commit.author && chosen.author) {
          picked = { author: chosen.author, commit: chosen.commit.author };
          pickedRepo = repo.fullName;
          break;
        }
      } catch (err) {
        console.warn(`  failed to read commits from ${repo.fullName}:`, (err as Error).message);
      }
    }

    if (!picked || !picked.author) {
      console.log("  could not find a non-bot committer on any enabled repo — skipping");
      continue;
    }

    const update = {
      commitAuthorName: picked.commit.name ?? null,
      commitAuthorEmail: picked.commit.email ?? null,
      commitAuthorGithubLogin: picked.author.login ?? null,
      commitAuthorGithubId: picked.author.id ?? null,
      commitAuthorAvatarUrl: picked.author.avatar_url ?? null,
      commitAuthorSetByUserId: null,
      commitAuthorSetAt: new Date(),
    };
    console.log(
      `  picked from ${pickedRepo}: ${update.commitAuthorName} <${update.commitAuthorEmail}> (gh:${update.commitAuthorGithubLogin})`,
    );
    if (dry) {
      console.log("  [dry-run] not writing");
      continue;
    }
    await db
      .update(schema.githubInstallations)
      .set(update)
      .where(eq(schema.githubInstallations.id, install.id));
    console.log("  updated");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
