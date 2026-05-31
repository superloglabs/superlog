// Updates an existing PR's title/body using a Superlog GitHub App token.
// Same token-minting flow as push-and-open-pr.ts; intended to be run via
//   railway run --service worker -- pnpm tsx scripts/update-pr-body.ts \
//     --repo <full_name> --installation <id> --repo-id <id> \
//     --pr <number> --body-file <path>
import crypto from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";

const GITHUB_API = "https://api.github.com";

type Args = {
  repo: string;
  installation: number;
  repoId: number;
  pr: number;
  bodyFile: string;
  title?: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, optional = false): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) {
      if (optional) return undefined;
      throw new Error(`missing ${flag}`);
    }
    if (i + 1 >= argv.length) throw new Error(`missing value for ${flag}`);
    return argv[i + 1]!;
  };
  return {
    repo: get("--repo")!,
    installation: Number(get("--installation")),
    repoId: Number(get("--repo-id")),
    pr: Number(get("--pr")),
    bodyFile: get("--body-file")!,
    title: get("--title", true),
  };
}

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

async function mintWriteToken(installationId: number, repositoryId: number): Promise<string> {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey =
    process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
    (process.env.GITHUB_APP_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8")
      : undefined);
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID + private key required");

  const jwt = signJwt(appId, privateKey);
  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "superlog-onboard",
      },
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: { pull_requests: "write" },
      }),
    },
  );
  if (!res.ok) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const body = await fs.readFile(args.bodyFile, "utf8");
  const token = await mintWriteToken(args.installation, args.repoId);

  const payload: Record<string, unknown> = { body };
  if (args.title) payload.title = args.title;

  const res = await fetch(`${GITHUB_API}/repos/${args.repo}/pulls/${args.pr}`, {
    method: "PATCH",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-onboard",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`PATCH failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { html_url: string; number: number };
  console.log(JSON.stringify({ pr_url: data.html_url, pr_number: data.number }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
