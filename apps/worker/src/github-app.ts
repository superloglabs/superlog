import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "./logger.js";

type GithubPermission = "read" | "write";

type GitResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type GithubRepoInfo = {
  id: number;
  full_name: string;
  default_branch: string;
  html_url: string;
};

type GithubPullRequest = {
  html_url: string;
  number: number;
  node_id: string;
  head: { sha: string };
  user?: { login?: string; id?: number; avatar_url?: string } | null;
};

export type GithubInstallationRepo = {
  id: number;
  fullName: string;
  private: boolean;
};

type GithubInstallationReposResponse = {
  repositories: Array<{ id: number; full_name: string; private: boolean }>;
};

const GITHUB_API = "https://api.github.com";
const GIT_PUSH_MAX_ATTEMPTS = 3;
const GIT_PUSH_RETRY_DELAYS_MS = [1_000, 3_000] as const;

function formatGitCommand(args: string[]): string {
  return `git ${args.join(" ")}`;
}

export function assertSafeGitArgs(args: string[]): void {
  if (args.some((arg) => /x-access-token:|authorization:|extraHeader=/i.test(arg))) {
    throw new Error("refusing to run git with credentials in argv");
  }
}

// Defense-in-depth scrub for anything we log out of git stdout/stderr. Auth is
// passed via the GIT_CONFIG extraHeader env var (never argv or the remote URL),
// so git's own output should not contain a token — but redact known credential
// shapes anyway so a future change can't turn a log line into a leak.
export function redactGitSecrets(text: string): string {
  return text
    .replace(/\bgh([opsu])_[A-Za-z0-9]{20,}/g, "gh$1_***") // ghp_/gho_/ghs_/ghu_ tokens
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
    .replace(/x-access-token:[^@\s/"']+/gi, "x-access-token:***")
    .replace(/AUTHORIZATION:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "AUTHORIZATION: Basic ***");
}

export function isRetryableGitPushFailure(_output: string): boolean {
  return true;
}

export function isGitPushBranchCollision(output: string): boolean {
  return /\(fetch first\)|non-fast-forward|remote contains work that you do not have locally/i.test(
    output,
  );
}

export function isMissingRemoteBranchFailure(output: string): boolean {
  return /could not find remote branch|remote branch .* not found/i.test(output);
}

export function formatRetryBranchName(
  branchName: string,
  seed: string = crypto.randomUUID(),
): string {
  const suffix = seed
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 8);
  return `${branchName}-retry-${suffix || crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function githubGitAuthEnv(token: string): NodeJS.ProcessEnv {
  const header = `AUTHORIZATION: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: header,
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

function getGithubAppConfig(): { appId: string; privateKey: string } | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey =
    process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
    (process.env.GITHUB_APP_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8")
      : undefined);
  if (!appId || !privateKey) return null;
  return { appId, privateKey };
}

function signGithubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function githubRequest<T>(
  pathname: string,
  opts: {
    method?: string;
    body?: unknown;
    bearerToken: string;
  },
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${pathname}`, {
    method: opts.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${opts.bearerToken}`,
      "content-type": "application/json; charset=utf-8",
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-worker",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github ${opts.method ?? "GET"} ${pathname} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function createInstallationToken(opts: {
  installationId: number;
  permissions?: Record<string, GithubPermission>;
  repositoryIds?: number[];
}): Promise<string> {
  const cfg = getGithubAppConfig();
  if (!cfg) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required");
  const appJwt = signGithubAppJwt(cfg.appId, cfg.privateKey);
  const data = await githubRequest<{ token: string }>(
    `/app/installations/${opts.installationId}/access_tokens`,
    {
      method: "POST",
      bearerToken: appJwt,
      body: {
        permissions: opts.permissions,
        repository_ids: opts.repositoryIds,
      },
    },
  );
  return data.token;
}

export async function createGithubReadToken(
  installationId: number,
  repositoryId?: number,
): Promise<string> {
  return createInstallationToken({
    installationId,
    repositoryIds: repositoryId ? [repositoryId] : undefined,
    permissions: { contents: "read" },
  });
}

export async function createGithubWriteToken(
  installationId: number,
  repositoryId?: number,
): Promise<string> {
  return createInstallationToken({
    installationId,
    repositoryIds: repositoryId ? [repositoryId] : undefined,
    permissions: { contents: "write", pull_requests: "write" },
  });
}

// Post a comment on an agent PR — used to route a continuation turn's reply
// back to the channel it came in on (a PR comment gets a PR answer). Best-effort
// and idempotency-free: the caller only fires this once per completed turn.
export async function postAgentPrComment(opts: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  body: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const token = await createGithubWriteToken(opts.installationId);
    const res = await fetch(
      `${GITHUB_API}/repos/${opts.repoFullName}/issues/${opts.prNumber}/comments`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
          "x-github-api-version": "2022-11-28",
          "user-agent": "superlog-worker",
        },
        body: JSON.stringify({ body: opts.body }),
      },
    );
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, error: `github POST issue comment ${res.status} ${text}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getGithubRepoInfo(
  installationId: number,
  repoFullName: string,
  repositoryId?: number,
): Promise<GithubRepoInfo> {
  const token = await createGithubReadToken(installationId, repositoryId);
  return githubRequest<GithubRepoInfo>(`/repos/${repoFullName}`, { bearerToken: token });
}

export async function listGithubInstallationRepositories(
  installationId: number,
): Promise<GithubInstallationRepo[]> {
  const token = await createGithubReadToken(installationId);
  const repos: GithubInstallationRepo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await githubRequest<GithubInstallationReposResponse>(
      `/installation/repositories?per_page=100&page=${page}`,
      { bearerToken: token },
    );
    repos.push(
      ...data.repositories.map((repo) => ({
        id: repo.id,
        fullName: repo.full_name,
        private: repo.private,
      })),
    );
    if (data.repositories.length < 100) break;
  }
  return repos;
}

function runGit(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<GitResult> {
  assertSafeGitArgs(args);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: gitEnv(opts.env),
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

async function ensureGitOk(
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    suppressOutputOnError?: boolean;
  } = {},
): Promise<GitResult> {
  const result = await runGit(args, opts);
  if (result.code !== 0) {
    throwGitFailure(args, opts, result);
  }
  return result;
}

class GitCommandError extends Error {
  readonly publicDetail: string;
  readonly command: string;
  readonly exitCode: number;

  constructor(args: string[], result: GitResult, opts: { suppressOutputOnError?: boolean }) {
    const command = formatGitCommand(args);
    const detail = gitFailureDetail(result);
    const output = opts.suppressOutputOnError || !detail ? "" : `: ${detail}`;
    super(`${command} failed with exit ${result.code}${output}`);
    this.name = "GitCommandError";
    this.command = command;
    this.exitCode = result.code;
    this.publicDetail = detail;
  }
}

function gitFailureDetail(result: GitResult): string {
  return redactGitSecrets((result.stderr || result.stdout || "").trim());
}

function publicGitErrorDetail(err: unknown): string {
  if (err instanceof GitCommandError) return err.publicDetail;
  if (err instanceof Error) return redactGitSecrets(err.message);
  return redactGitSecrets(String(err));
}

async function ensureGitPushOk(
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    suppressOutputOnError?: boolean;
  },
): Promise<GitResult> {
  for (let attempt = 1; attempt <= GIT_PUSH_MAX_ATTEMPTS; attempt++) {
    const result = await runGit(args, opts);
    if (result.code === 0) return result;

    const detail = gitFailureDetail(result);
    const canRetry =
      attempt < GIT_PUSH_MAX_ATTEMPTS && isRetryableGitPushFailure(result.stderr || result.stdout);
    if (!canRetry) throwGitFailure(args, opts, result);

    const delayMs = GIT_PUSH_RETRY_DELAYS_MS[attempt - 1] ?? GIT_PUSH_RETRY_DELAYS_MS.at(-1) ?? 0;
    logger.warn(
      {
        scope: "github-app.git",
        command: formatGitCommand(args),
        exit_code: result.code,
        attempt,
        next_attempt: attempt + 1,
        max_attempts: GIT_PUSH_MAX_ATTEMPTS,
        retry_delay_ms: delayMs,
        output: detail.slice(0, 4000),
      },
      "git push failed with retryable output; retrying",
    );
    await sleep(delayMs);
  }

  throw new Error(`${formatGitCommand(args)} failed after ${GIT_PUSH_MAX_ATTEMPTS} attempts`);
}

function throwGitFailure(
  args: string[],
  opts: { suppressOutputOnError?: boolean },
  result: GitResult,
): never {
  const detail = gitFailureDetail(result);
  // Always log the (scrubbed) git output so failures like a server-side push
  // rejection (branch protection, required signed commits, push protection)
  // are diagnosable. We keep it out of the thrown Error message when
  // suppressOutputOnError is set, because that message can flow into the
  // user-facing agent-run summary — but the log is operator-only.
  if (detail) {
    logger.warn(
      {
        scope: "github-app.git",
        command: formatGitCommand(args),
        exit_code: result.code,
        output: detail.slice(0, 4000),
      },
      "git command failed",
    );
  }
  throw new GitCommandError(args, result, opts);
}

export function normalizeAgentPatch(rawPatch: string): string {
  let patch = rawPatch.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  const fenced = patch.match(/^```(?:diff|patch)?[ \t]*\n([\s\S]*?)\n```[ \t]*\n?$/i);
  if (fenced?.[1]) {
    patch = fenced[1];
  }

  const firstDiff = patch.search(/^diff --git /m);
  if (firstDiff > 0) {
    patch = patch.slice(firstDiff);
  }

  const lines = patch.split("\n");
  const trailingFence = lines.findIndex((line, index) => index > 0 && line.trim() === "```");
  if (trailingFence >= 0 && lines.slice(trailingFence + 1).every((line) => line.trim() === "")) {
    patch = lines.slice(0, trailingFence).join("\n").trimEnd();
  }

  return patch.endsWith("\n") ? patch : `${patch}\n`;
}

function gitApplyError(args: string[], result: GitResult, patch: string): Error {
  const output = (result.stderr || result.stdout).trim();
  const lineMatch = output.match(
    /(?:corrupt patch|patch fragment without header|unrecognized input).*line (\d+)/i,
  );
  const lineNumber = lineMatch?.[1] ? Number(lineMatch[1]) : null;
  let detail = output;

  if (lineNumber && Number.isFinite(lineNumber)) {
    const lines = patch.split("\n");
    const start = Math.max(1, lineNumber - 4);
    const end = Math.min(lines.length, lineNumber + 4);
    const context = lines
      .slice(start - 1, end)
      .map((line, index) => {
        const current = start + index;
        const marker = current === lineNumber ? ">" : " ";
        return `${marker} ${String(current).padStart(4, " ")} | ${line}`;
      })
      .join("\n");
    detail = `${detail}\nPatch context around line ${lineNumber}:\n${context}`;
  }

  return new Error(`${formatGitCommand(args)} failed: ${detail}`);
}

// Applies an agent-authored patch into a checked-out repo.
//
// Uses `git apply --3way`: the agent diffs its patch against the base commit it
// cloned, but by delivery time the base branch may have moved — including edits
// to the very context lines the hunk relies on. Plain `git apply` has zero
// tolerance for that and fails with "patch does not apply". `--3way`
// reconstructs the agent's original file from the pre-image blob recorded in
// the diff's `index <sha>..<sha>` line and 3-way merges the change in, so a
// non-overlapping drift still lands. A genuine, overlapping content conflict
// still exits non-zero (leaving conflict markers in the throwaway workdir) — we
// surface it as a failure rather than push conflict-marked files.
//
// `env` must carry the GitHub auth header: with a blobless partial clone the
// pre-image blob is not present locally, so `--3way` lazily fetches it from the
// `origin` promisor remote during apply — an unauthenticated fetch would 404.
export async function applyAgentPatch(opts: {
  repoDir: string;
  patchPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const applyArgs = ["apply", "--3way", "--index", "--whitespace=nowarn", opts.patchPath];
  const result = await runGit(applyArgs, { cwd: opts.repoDir, env: opts.env });
  if (result.code !== 0) {
    const patchBody = await readFile(opts.patchPath, "utf8").catch(() => "");
    throw gitApplyError(applyArgs, result, patchBody);
  }
}

async function cloneRepositoryAtBaseBranch(opts: {
  repoFullName: string;
  repoDir: string;
  preferredBaseBranch: string;
  defaultBranch: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const clone = (branch: string) =>
    ensureGitOk(
      [
        "clone",
        // Blobless partial clone: skip downloading file contents up front and
        // fetch only the blobs we actually touch on demand. This keeps `git
        // apply --3way` able to reconstruct the agent's pre-image blob (so it
        // can merge across base-branch drift) without paying a full-history
        // download per delivery. `--depth 1` would omit those blobs entirely.
        "--filter=blob:none",
        "--branch",
        branch,
        `https://github.com/${opts.repoFullName}.git`,
        opts.repoDir,
      ],
      { env: opts.env, suppressOutputOnError: true },
    );

  try {
    await clone(opts.preferredBaseBranch);
    return opts.preferredBaseBranch;
  } catch (err) {
    const detail = publicGitErrorDetail(err);
    if (opts.preferredBaseBranch !== opts.defaultBranch && isMissingRemoteBranchFailure(detail)) {
      logger.warn(
        {
          scope: "github-app.git",
          repo: opts.repoFullName,
          preferred_base_branch: opts.preferredBaseBranch,
          fallback_base_branch: opts.defaultBranch,
          output: detail.slice(0, 4000),
        },
        "preferred base branch was missing; falling back to repository default branch",
      );
      await rm(opts.repoDir, { recursive: true, force: true }).catch(() => {});
      await clone(opts.defaultBranch);
      return opts.defaultBranch;
    }
    throw err;
  }
}

async function pushBranchWithCollisionFallback(opts: {
  repoDir: string;
  env: NodeJS.ProcessEnv;
  branchName: string;
  repoFullName: string;
}): Promise<string> {
  const push = (branchName: string) =>
    ensureGitPushOk(["push", "origin", `HEAD:refs/heads/${branchName}`], {
      cwd: opts.repoDir,
      env: opts.env,
      suppressOutputOnError: true,
    });

  try {
    await push(opts.branchName);
    return opts.branchName;
  } catch (err) {
    const detail = publicGitErrorDetail(err);
    if (!isGitPushBranchCollision(detail)) throw err;

    const fallbackBranchName = formatRetryBranchName(opts.branchName);
    logger.warn(
      {
        scope: "github-app.git",
        repo: opts.repoFullName,
        original_branch: opts.branchName,
        fallback_branch: fallbackBranchName,
        output: detail.slice(0, 4000),
      },
      "remote branch already had different commits; retrying push with a fresh branch name",
    );
    await push(fallbackBranchName);
    return fallbackBranchName;
  }
}

export async function applyPatchAndOpenPr(opts: {
  installationId: number;
  repositoryId?: number;
  repoFullName: string;
  patch: string;
  branchName: string;
  title: string;
  body: string;
  baseBranch?: string | null;
  commitAuthor?: { name: string; email: string } | null;
}): Promise<{
  prUrl: string;
  prNumber: number;
  prNodeId: string;
  headSha: string;
  authorLogin: string | null;
  authorGithubId: number | null;
  authorAvatarUrl: string | null;
  branchName: string;
  baseBranch: string;
}> {
  const repo = await getGithubRepoInfo(opts.installationId, opts.repoFullName, opts.repositoryId);
  const preferredBaseBranch = opts.baseBranch?.trim() || repo.default_branch;
  const workdir = await mkdtemp(path.join(os.tmpdir(), "superlog-pr-"));
  const writeToken = await createGithubWriteToken(opts.installationId, opts.repositoryId);
  const gitAuthEnv = githubGitAuthEnv(writeToken);
  const repoDir = path.join(workdir, "repo");

  try {
    const baseBranch = await cloneRepositoryAtBaseBranch({
      repoFullName: opts.repoFullName,
      repoDir,
      preferredBaseBranch,
      defaultBranch: repo.default_branch,
      env: gitAuthEnv,
    });
    await ensureGitOk(["checkout", "-b", opts.branchName], { cwd: repoDir });
    const gitIdentity = resolveGitIdentity(opts.commitAuthor);
    await ensureGitOk(["config", "user.name", gitIdentity.name], { cwd: repoDir });
    await ensureGitOk(["config", "user.email", gitIdentity.email], { cwd: repoDir });

    // Written OUTSIDE the repo checkout: an untracked patch file inside
    // repoDir would make `git status --porcelain` non-empty even when the
    // patch changed nothing, defeating the no-op detection below.
    const patchPath = path.join(workdir, "superlog.patch");
    const patchBody = normalizeAgentPatch(opts.patch);
    await writeFile(patchPath, patchBody, "utf8");
    await applyAgentPatch({ repoDir, patchPath, env: gitAuthEnv });

    // The agent validates its own patch inside its session sandbox (running
    // the project's build/tests/repro as it sees fit) and reports the outcome
    // in `pr.validationSummary`. The worker no longer installs dependencies or
    // executes agent-authored commands here — doing so ran untrusted code (repo
    // lifecycle scripts + LLM-authored shell) on the worker with its full
    // environment. We just apply the patch, commit, push, and open the PR.
    const status = await ensureGitOk(["status", "--porcelain"], { cwd: repoDir });
    if (!status.stdout.trim()) {
      throw new Error("patch produced no working tree changes");
    }

    await ensureGitOk(["commit", "--no-verify", "-m", opts.title], { cwd: repoDir });
    const headBranch = await pushBranchWithCollisionFallback({
      repoDir,
      env: gitAuthEnv,
      branchName: opts.branchName,
      repoFullName: opts.repoFullName,
    });

    const prBody = opts.body;
    const pr = await githubRequest<GithubPullRequest>(`/repos/${opts.repoFullName}/pulls`, {
      method: "POST",
      bearerToken: writeToken,
      body: {
        title: opts.title,
        head: headBranch,
        base: baseBranch,
        body: prBody,
        maintainer_can_modify: false,
      },
    });

    // Append a feedback link to the PR body now that we know the PR
    // number. Done as a follow-up PATCH (rather than baked into the
    // initial POST) because the link is keyed by pr.number — which the
    // server only assigns on creation. Best-effort: a 4xx here doesn't
    // unwind the PR, the link is just nice-to-have.
    const feedbackOrigin = process.env.WEB_ORIGIN ?? "https://superlog.sh";
    const feedbackFooter = renderFeedbackFooter({
      webOrigin: feedbackOrigin,
      repoFullName: opts.repoFullName,
      prNumber: pr.number,
    });
    if (feedbackFooter) {
      try {
        await githubRequest(`/repos/${opts.repoFullName}/pulls/${pr.number}`, {
          method: "PATCH",
          bearerToken: writeToken,
          body: { body: `${prBody}${feedbackFooter}` },
        });
      } catch (err) {
        // The PR is already open — the footer is decorative, so we don't
        // unwind. But surface a WARN so a consistent failure mode (token
        // missing contents:write, rate-limited, etc.) is detectable in
        // logs instead of silently producing PRs without the link.
        logger.warn(
          {
            scope: "github-app",
            err,
            pr_number: pr.number,
            repo: opts.repoFullName,
          },
          "feedback footer patch failed",
        );
      }
    }

    return {
      prUrl: pr.html_url,
      prNumber: pr.number,
      prNodeId: pr.node_id,
      headSha: pr.head.sha,
      authorLogin: pr.user?.login ?? null,
      authorGithubId: pr.user?.id ?? null,
      authorAvatarUrl: pr.user?.avatar_url ?? null,
      branchName: headBranch,
      baseBranch,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

// Follow-up delivery: apply a new patch as an additional commit on an
// EXISTING agent PR branch (no new branch, no new PR) and reply on the PR.
// The patch is expected to be based on the PR branch head — the follow-up
// prompt instructs the agent to work on that branch. A non-fast-forward
// push (someone pushed to the branch meanwhile) throws; the caller fails
// the run rather than guessing at a merge.
export async function pushPatchToExistingAgentPr(opts: {
  installationId: number;
  repositoryId?: number;
  repoFullName: string;
  patch: string;
  branchName: string;
  prNumber: number;
  commitTitle: string;
  commentBody: string | null;
  commitAuthor?: { name: string; email: string } | null;
}): Promise<{ headSha: string }> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "superlog-pr-update-"));
  const writeToken = await createGithubWriteToken(opts.installationId, opts.repositoryId);
  const gitAuthEnv = githubGitAuthEnv(writeToken);
  const repoDir = path.join(workdir, "repo");

  try {
    await ensureGitOk(
      [
        "clone",
        // Blobless partial clone — see cloneRepositoryAtBaseBranch: lets the
        // `--3way` apply below fetch the agent's pre-image blobs on demand so a
        // follow-up patch still lands if the PR branch moved.
        "--filter=blob:none",
        "--branch",
        opts.branchName,
        `https://github.com/${opts.repoFullName}.git`,
        repoDir,
      ],
      { env: gitAuthEnv, suppressOutputOnError: true },
    );
    const gitIdentity = resolveGitIdentity(opts.commitAuthor);
    await ensureGitOk(["config", "user.name", gitIdentity.name], { cwd: repoDir });
    await ensureGitOk(["config", "user.email", gitIdentity.email], { cwd: repoDir });

    // Written OUTSIDE the repo checkout: an untracked patch file inside
    // repoDir would make `git status --porcelain` non-empty even when the
    // patch changed nothing, defeating the no-op detection below.
    const patchPath = path.join(workdir, "superlog.patch");
    const patchBody = normalizeAgentPatch(opts.patch);
    await writeFile(patchPath, patchBody, "utf8");
    await applyAgentPatch({ repoDir, patchPath, env: gitAuthEnv });
    const status = await ensureGitOk(["status", "--porcelain"], { cwd: repoDir });
    if (!status.stdout.trim()) {
      throw new Error("patch produced no working tree changes");
    }
    await ensureGitOk(["commit", "--no-verify", "-m", opts.commitTitle], { cwd: repoDir });
    await ensureGitPushOk(["push", "origin", `HEAD:refs/heads/${opts.branchName}`], {
      cwd: repoDir,
      env: gitAuthEnv,
      suppressOutputOnError: true,
    });
    const headSha = (await ensureGitOk(["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();

    if (opts.commentBody) {
      // Best-effort: the push already landed; a failed comment shouldn't
      // unwind the delivery.
      try {
        await githubRequest(`/repos/${opts.repoFullName}/issues/${opts.prNumber}/comments`, {
          method: "POST",
          bearerToken: writeToken,
          body: { body: opts.commentBody },
        });
      } catch (err) {
        logger.warn(
          { scope: "github-app", err, pr_number: opts.prNumber, repo: opts.repoFullName },
          "follow-up PR comment failed",
        );
      }
    }

    return { headSha };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

// Footer appended to every agent-opened PR description so customers can
// leave feedback in one click. Must contain the marker
// `/feedback/pr/` because the github webhook handler filters its own
// echoed-back footer out of the PR comments stream (see
// FEEDBACK_PR_FOOTER_MARKER in apps/api/src/feedback.ts).
function renderFeedbackFooter(opts: {
  webOrigin: string;
  repoFullName: string;
  prNumber: number;
}): string {
  const [owner, repo] = opts.repoFullName.split("/");
  if (!owner || !repo) return "";
  const url = `${opts.webOrigin}/feedback/pr/${owner}/${repo}/${opts.prNumber}`;
  return `\n\n---\n_Was this PR helpful? [Leave feedback](${url}) — goes straight to the Superlog team._`;
}

const FALLBACK_GIT_IDENTITY = { name: "superlog-bot", email: "bot@superlog.sh" };

function resolveGitIdentity(author: { name: string; email: string } | null | undefined): {
  name: string;
  email: string;
} {
  if (!author) return FALLBACK_GIT_IDENTITY;
  const name = author.name
    .replace(/[\r\n<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const email = author.email.trim();
  if (!name || !email || /[\r\n<>]/.test(email) || !email.includes("@")) {
    return FALLBACK_GIT_IDENTITY;
  }
  return { name, email };
}

type GithubPrDetail = {
  state: "open" | "closed";
  merged_at: string | null;
};

export async function getObsPrMerged(
  installationId: number,
  repositoryId: number,
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const token = await createGithubReadToken(installationId, repositoryId);
    const pr = await githubRequest<GithubPrDetail>(`/repos/${repoFullName}/pulls/${prNumber}`, {
      bearerToken: token,
    });
    return pr.merged_at !== null;
  } catch {
    return false;
  }
}

export async function closeAgentPullRequestOnGithub(opts: {
  installationId: number;
  fallbackInstallationIds?: number[];
  repoFullName: string;
  prNumber: number;
  prNodeId?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const installationId of dedupeInstallationIds([
    opts.installationId,
    ...(opts.fallbackInstallationIds ?? []),
  ])) {
    try {
      const token = await createGithubWriteToken(installationId);
      const result = await closeGithubPullRequestWithToken({
        token,
        repoFullName: opts.repoFullName,
        prNumber: opts.prNumber,
        prNodeId: opts.prNodeId,
        userAgent: "superlog-worker",
      });
      if (result.ok) return result;
      errors.push(`installation ${installationId}: ${result.error}`);
    } catch (err) {
      errors.push(
        `installation ${installationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { ok: false, error: errors.join("; ") || "no github installations available" };
}

async function closeGithubPullRequestWithToken(opts: {
  token: string;
  repoFullName: string;
  prNumber: number;
  prNodeId?: string | null;
  userAgent: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const errors: string[] = [];
  if (opts.prNodeId) {
    const res = await fetchImpl(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json; charset=utf-8",
        "x-github-api-version": "2022-11-28",
        "user-agent": opts.userAgent,
      },
      body: JSON.stringify({
        query: `mutation ClosePullRequest($pullRequestId: ID!) {
          closePullRequest(input: { pullRequestId: $pullRequestId }) {
            pullRequest { id closed }
          }
        }`,
        variables: { pullRequestId: opts.prNodeId },
      }),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) {
      const data = text ? parseGithubGraphqlResponse(text) : {};
      if (!data.errors?.length) return { ok: true };
    }
    errors.push(`github GraphQL closePullRequest ${res.status} ${text}`);
  }

  const res = await fetchImpl(`${GITHUB_API}/repos/${opts.repoFullName}/pulls/${opts.prNumber}`, {
    method: "PATCH",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/json; charset=utf-8",
      "x-github-api-version": "2022-11-28",
      "user-agent": opts.userAgent,
    },
    body: JSON.stringify({ state: "closed" }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  errors.push(`github PATCH /pulls/${opts.prNumber} ${res.status} ${text}`);
  return { ok: false, error: errors.join("; ") };
}

function parseGithubGraphqlResponse(text: string): { errors?: unknown[] } {
  try {
    return JSON.parse(text) as { errors?: unknown[] };
  } catch {
    return { errors: [{ message: "invalid json response" }] };
  }
}

function dedupeInstallationIds(values: number[]): number[] {
  return [...new Set(values)];
}

export type AutoMergeMethod = "squash" | "merge" | "rebase";
export type AutoMergePolicy = "never" | "when_checks_pass" | "immediately";

export type MergeAgentPrOutcome =
  | { kind: "merged"; sha: string | null }
  | { kind: "auto_merge_enabled" }
  | { kind: "skipped"; reason: string };

// "when_checks_pass" enables GitHub's native auto-merge, which queues the
// merge until required checks/reviews pass. "immediately" tries the merge
// right now and fails if branch protection blocks it.
export async function mergeAgentPullRequest(opts: {
  installationId: number;
  repositoryId: number;
  repoFullName: string;
  prNumber: number;
  prNodeId: string;
  policy: AutoMergePolicy;
  method: AutoMergeMethod;
}): Promise<MergeAgentPrOutcome> {
  if (opts.policy === "never") {
    return { kind: "skipped", reason: "policy=never" };
  }
  const token = await createGithubWriteToken(opts.installationId, opts.repositoryId);

  if (opts.policy === "when_checks_pass") {
    const mergeMethod = opts.method.toUpperCase();
    const query = `mutation($prId: ID!, $method: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: $method }) {
        pullRequest { id }
      }
    }`;
    const res = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        "user-agent": "superlog-worker",
      },
      body: JSON.stringify({
        query,
        variables: { prId: opts.prNodeId, method: mergeMethod },
      }),
    });
    const json = (await res.json().catch(() => null)) as {
      errors?: Array<{ message?: string; type?: string }>;
    } | null;
    if (!res.ok || (json?.errors && json.errors.length > 0)) {
      const message = json?.errors?.[0]?.message ?? `status ${res.status}`;
      throw new Error(`enablePullRequestAutoMerge failed: ${message}`);
    }
    return { kind: "auto_merge_enabled" };
  }

  const res = await fetch(`${GITHUB_API}/repos/${opts.repoFullName}/pulls/${opts.prNumber}/merge`, {
    method: "PUT",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-worker",
    },
    body: JSON.stringify({ merge_method: opts.method }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PUT /pulls/${opts.prNumber}/merge failed: ${res.status} ${text}`);
  }
  const body = (await res.json().catch(() => ({}))) as { sha?: string };
  return { kind: "merged", sha: body.sha ?? null };
}
