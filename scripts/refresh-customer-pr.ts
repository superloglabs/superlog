// Force-pushes a local branch to a customer repo and (optionally) updates an
// existing PR's body, using a Superlog GitHub App write token.
//
//   railway run --service worker -- pnpm tsx scripts/refresh-customer-pr.ts \
//     --repo <full_name> --installation <id> --repo-id <id> \
//     --dir <local_clone> --branch <branch> [--body-file <path>] [--title <title>]
//
// Behavior:
//   * Mints a contents:write + pull_requests:write token scoped to the single repo.
//   * Force-pushes HEAD of <dir> to refs/heads/<branch> via the token.
//     The token is passed through git's process env config, never argv or remotes.
//   * Looks up the open PR with head=<owner>:<branch>; if found and body-file
//     given, PATCHes title/body.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import process from "node:process";

const GITHUB_API = "https://api.github.com";

type Args = {
  repo: string;
  installation: number;
  repoId: number;
  dir: string;
  branch: string;
  bodyFile?: string;
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
    dir: get("--dir")!,
    branch: get("--branch")!,
    bodyFile: get("--body-file", true),
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
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
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
      permissions: { contents: "write", pull_requests: "write" },
    }),
  });
  if (!res.ok) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_CURL_VERBOSE",
    "GIT_TRACE",
    "GIT_TRACE_CURL",
    "GIT_TRACE_PACKET",
    "GIT_TRACE_PERFORMANCE",
    "GIT_TRACE_SETUP",
  ]) {
    delete env[key];
  }
  return env;
}

function assertNoGitArgCredentials(args: string[]): void {
  if (args.some((arg) => /x-access-token:|authorization:|extraHeader=/i.test(arg))) {
    throw new Error("refusing to run git with credentials in argv");
  }
}

async function git(
  args: string[],
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; suppressOutputOnError?: boolean } = {},
): Promise<string> {
  assertNoGitArgCredentials(args);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(opts.env),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else {
        const output = opts.suppressOutputOnError ? "" : `: ${err || out}`;
        reject(new Error(`git ${args.join(" ")} failed with exit ${code ?? 1}${output}`));
      }
    });
  });
}

async function findOpenPr(
  token: string,
  repoFullName: string,
  branch: string,
): Promise<{ number: number; html_url: string } | null> {
  const owner = repoFullName.split("/")[0];
  const url = `${GITHUB_API}/repos/${repoFullName}/pulls?state=open&head=${owner}:${branch}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-onboard",
    },
  });
  if (!res.ok) throw new Error(`list PRs failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as Array<{ number: number; html_url: string }>;
  return data[0] ?? null;
}

async function patchPr(
  token: string,
  repoFullName: string,
  prNumber: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, {
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
  if (!res.ok) throw new Error(`PATCH PR failed: ${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const token = await mintWriteToken(args.installation, args.repoId);

  await git(
    ["push", "--force", `https://github.com/${args.repo}.git`, `HEAD:refs/heads/${args.branch}`],
    args.dir,
    { env: gitAuthEnv(token), suppressOutputOnError: true },
  );

  const pr = await findOpenPr(token, args.repo, args.branch);
  if (pr && (args.bodyFile || args.title)) {
    const payload: Record<string, unknown> = {};
    if (args.bodyFile) payload.body = await fs.readFile(args.bodyFile, "utf8");
    if (args.title) payload.title = args.title;
    await patchPr(token, args.repo, pr.number, payload);
  }
  console.log(
    JSON.stringify(
      {
        pushed_branch: args.branch,
        pr_number: pr?.number ?? null,
        pr_url: pr?.html_url ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
