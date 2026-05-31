// Pushes a local clone to a customer repo and opens a PR using a Superlog
// GitHub App write token. Run via Railway so prod App credentials are injected
// without ever being printed:
//
//   railway run --service worker -- pnpm tsx scripts/push-and-open-pr.ts \
//     --repo <full_name> --installation <id> --repo-id <id> \
//     --dir <local_clone> --branch <branch> --base <base_branch> \
//     --title <title> --body-file <path_to_md>
//
// The token is scoped to a single repo with contents:write + pull_requests:write.
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
  base: string;
  title: string;
  bodyFile: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) {
      throw new Error(`missing ${flag}`);
    }
    return argv[i + 1]!;
  };
  return {
    repo: get("--repo"),
    installation: Number(get("--installation")),
    repoId: Number(get("--repo-id")),
    dir: get("--dir"),
    branch: get("--branch"),
    base: get("--base"),
    title: get("--title"),
    bodyFile: get("--body-file"),
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
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(opts.env),
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += String(c)));
  child.stderr.on("data", (c) => (err += String(c)));
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const output = opts.suppressOutputOnError ? "" : `: ${err || out}`;
        reject(new Error(`git ${args.join(" ")} failed with exit ${code ?? 1}${output}`));
      }
    });
  });
  return out;
}

async function openPr(
  token: string,
  repoFullName: string,
  args: { title: string; body: string; head: string; base: string },
): Promise<{ url: string; number: number }> {
  const res = await fetch(`${GITHUB_API}/repos/${repoFullName}/pulls`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-onboard",
    },
    body: JSON.stringify({
      title: args.title,
      head: args.head,
      base: args.base,
      body: args.body,
      maintainer_can_modify: false,
    }),
  });
  if (!res.ok) throw new Error(`open PR failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const body = await fs.readFile(args.bodyFile, "utf8");

  const token = await mintWriteToken(args.installation, args.repoId);

  // Configure local git identity for this commit
  await git(["config", "user.name", "superlog-bot"], args.dir);
  await git(["config", "user.email", "bot@superlog.sh"], args.dir);

  // Stage everything (modified + new files), commit, push to a fresh branch
  await git(["checkout", "-b", args.branch], args.dir);
  await git(["add", "-A"], args.dir);
  await git(["commit", "-m", args.title], args.dir);

  await git(
    ["push", `https://github.com/${args.repo}.git`, `HEAD:refs/heads/${args.branch}`],
    args.dir,
    { env: gitAuthEnv(token), suppressOutputOnError: true },
  );

  const pr = await openPr(token, args.repo, {
    title: args.title,
    body,
    head: args.branch,
    base: args.base,
  });
  console.log(
    JSON.stringify({ pr_url: pr.url, pr_number: pr.number, branch: args.branch }, null, 2),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
