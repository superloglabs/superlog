// Clones a GitHub repo using a Superlog GitHub App installation token.
// Run via Railway so the prod App credentials are injected without ever being
// printed:
//
//   railway run --service worker -- pnpm tsx scripts/clone-with-app.ts \
//     <repoFullName> <installationId> <repoId> <destDir>
//
// Example:
//   railway run --service worker -- pnpm tsx scripts/clone-with-app.ts \
//     ontora-main/ontora 127107603 1150120049 /tmp/superlog-onboard-ontora
//
// The minted token is scoped to the single repository and only contents:read,
// so it cannot push, open PRs, or touch other repos in the install.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const GITHUB_API = "https://api.github.com";

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

async function mintReadToken(installationId: number, repositoryId: number): Promise<string> {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey =
    process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
    (process.env.GITHUB_APP_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8")
      : undefined);
  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY[_BASE64] must be set");
  }
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
      permissions: { contents: "read" },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token mint failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

function gitClone(token: string, repoFullName: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["clone", `https://github.com/${repoFullName}.git`, destDir], {
      stdio: "inherit",
      env: gitEnv({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${Buffer.from(`x-access-token:${token}`).toString(
          "base64",
        )}`,
      }),
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone exited ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const [repoFullName, installationIdRaw, repositoryIdRaw, destDir] = process.argv.slice(2);
  if (!repoFullName || !installationIdRaw || !repositoryIdRaw || !destDir) {
    console.error("usage: clone-with-app.ts <repoFullName> <installationId> <repoId> <destDir>");
    process.exit(2);
  }
  const installationId = Number(installationIdRaw);
  const repositoryId = Number(repositoryIdRaw);
  if (!Number.isFinite(installationId) || !Number.isFinite(repositoryId)) {
    throw new Error("installationId and repoId must be numbers");
  }

  const token = await mintReadToken(installationId, repositoryId);
  await gitClone(token, repoFullName, path.resolve(destDir));
  console.log(`cloned ${repoFullName} → ${destDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
