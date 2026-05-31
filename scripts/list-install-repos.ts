// Lists repos accessible to a GitHub App installation (read via App JWT).
// Run via Railway so prod App credentials aren't printed:
//   railway run --service worker -- pnpm tsx scripts/list-install-repos.ts <installationId>
import crypto from "node:crypto";
import process from "node:process";

const GITHUB_API = "https://api.github.com";

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

async function main(): Promise<void> {
  const installationId = Number(process.argv[2]);
  if (!Number.isFinite(installationId)) {
    console.error("usage: list-install-repos.ts <installationId>");
    process.exit(2);
  }
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey =
    process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
    (process.env.GITHUB_APP_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8")
      : undefined);
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID + private key required");

  const jwt = signJwt(appId, privateKey);

  // Mint a token for the installation (no repo restriction).
  const tokenRes = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "superlog-onboard",
      },
    },
  );
  if (!tokenRes.ok) {
    throw new Error(`token mint failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { token } = (await tokenRes.json()) as { token: string };

  // List repos using the installation token.
  const reposRes = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-onboard",
    },
  });
  if (!reposRes.ok) {
    throw new Error(`list repos failed: ${reposRes.status} ${await reposRes.text()}`);
  }
  const data = (await reposRes.json()) as {
    total_count: number;
    repositories: Array<{ id: number; full_name: string; default_branch: string; private: boolean }>;
  };
  console.log(JSON.stringify(
    {
      total_count: data.total_count,
      repositories: data.repositories.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        default_branch: r.default_branch,
        private: r.private,
      })),
    },
    null,
    2,
  ));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
