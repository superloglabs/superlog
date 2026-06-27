import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyAgentPatch,
  formatRetryBranchName,
  isGitPushBranchCollision,
  isMissingRemoteBranchFailure,
  isRetryableGitPushFailure,
  redactGitSecrets,
} from "./github-app.js";

test("redactGitSecrets scrubs GitHub installation/app tokens", () => {
  const token = ["ghs", "AbCdEf0123456789AbCdEf0123456789"].join("_");
  const out = redactGitSecrets(`fatal: Authentication failed for ${token}`);
  assert.ok(!out.includes(token), "raw token must not survive");
  assert.match(out, /ghs_\*\*\*/);
});

test("redactGitSecrets scrubs gho/ghp/ghu tokens and fine-grained PATs", () => {
  assert.match(
    redactGitSecrets(["ghp", "AbCdEf0123456789AbCdEf0123456789"].join("_")),
    /ghp_\*\*\*/,
  );
  assert.match(
    redactGitSecrets(["gho", "AbCdEf0123456789AbCdEf0123456789"].join("_")),
    /gho_\*\*\*/,
  );
  const pat = ["github", "pat", "11ABCDEFG0abcdefghij", "KLMNOPqrstuvwxyz0123456789"].join("_");
  const out = redactGitSecrets(pat);
  assert.ok(!out.includes(pat));
  assert.match(out, /github_pat_\*\*\*/);
});

test("redactGitSecrets scrubs x-access-token and basic auth headers", () => {
  const token = ["ghs", "AbCdEf0123456789AbCdEf0123456789"].join("_");
  const out = redactGitSecrets(`https://x-access-token:${token}@github.com/o/r.git`);
  assert.ok(!out.includes(token));
  assert.match(redactGitSecrets("AUTHORIZATION: Basic eC1hY2Nlc3M6c2VjcmV0"), /Basic \*\*\*/);
});

test("redactGitSecrets leaves benign git rejection messages intact", () => {
  const msg =
    "remote: error: GH006: Protected branch update failed for refs/heads/superlog/fix.\nremote: error: Changes must be made through a pull request.";
  assert.equal(redactGitSecrets(msg), msg);
});

test("isRetryableGitPushFailure retries any push failure output", () => {
  assert.equal(
    isRetryableGitPushFailure("error: RPC failed; curl 56 Recv failure: Connection reset by peer"),
    true,
  );
  assert.equal(isRetryableGitPushFailure("fatal: the remote end hung up unexpectedly"), true);
  assert.equal(isRetryableGitPushFailure("fatal: unable to access repo: HTTP 503"), true);
  assert.equal(
    isRetryableGitPushFailure("remote: error: GH006: Protected branch update failed"),
    true,
  );
  assert.equal(isRetryableGitPushFailure("fatal: Authentication failed"), true);
  assert.equal(isRetryableGitPushFailure("! [rejected] HEAD -> branch (non-fast-forward)"), true);
  assert.equal(isRetryableGitPushFailure("remote: error: GH013: Repository rule violations"), true);
});

test("isGitPushBranchCollision detects occupied remote branch failures", () => {
  assert.equal(
    isGitPushBranchCollision(
      "! [rejected] HEAD -> superlog/fix-refresh-token (fetch first)\nerror: failed to push some refs",
    ),
    true,
  );
  assert.equal(isGitPushBranchCollision("! [rejected] HEAD -> branch (non-fast-forward)"), true);
  assert.equal(
    isGitPushBranchCollision(
      "hint: Updates were rejected because the remote contains work that you do not have locally.",
    ),
    true,
  );
  assert.equal(
    isGitPushBranchCollision("remote: error: GH006: Protected branch update failed"),
    false,
  );
  assert.equal(isGitPushBranchCollision("fatal: Authentication failed"), false);
});

test("formatRetryBranchName appends a bounded retry suffix", () => {
  assert.equal(
    formatRetryBranchName("superlog/fix-refresh-token", "abcdef12" + "-3456"),
    "superlog/fix-refresh-token-retry-abcdef12",
  );
  assert.equal(formatRetryBranchName("superlog/fix", "bad chars!"), "superlog/fix-retry-bad-char");
});

test("isMissingRemoteBranchFailure detects clone failures for deleted base branches", () => {
  assert.equal(
    isMissingRemoteBranchFailure("warning: Could not find remote branch main to clone."),
    true,
  );
  assert.equal(
    isMissingRemoteBranchFailure("fatal: Remote branch main not found in upstream origin"),
    true,
  );
  assert.equal(isMissingRemoteBranchFailure("fatal: repository not found"), false);
});

// --- applyAgentPatch: real-git drift tolerance (Tier 0) ----------------------
//
// The agent diffs its patch against the base commit it cloned. By the time the
// worker applies it, the base branch may have moved — including edits to the
// very context lines the patch's hunk relies on. Plain `git apply` has zero
// tolerance for that and fails with "patch does not apply". `applyAgentPatch`
// uses `--3way`, which reconstructs the agent's original file from the
// pre-image blob recorded in the diff and 3-way merges the change in, so a
// non-overlapping drift still lands.

function git(cwd: string, args: string[], input?: string): string {
  const res = spawnSync("git", args, { cwd, input, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

// Builds a repo where the agent's patch edits line 10, then the base drifts by
// editing line 8 — a *context* line inside the patch hunk. Returns the repo dir
// and the path to the agent patch (written outside the repo, as in production).
async function buildDriftedRepo(): Promise<{
  workdir: string;
  repoDir: string;
  patchPath: string;
}> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "superlog-apply-test-"));
  const repoDir = path.join(workdir, "repo");
  await mkdtemp(repoDir).catch(() => {});
  git(workdir, ["init", "-q", "repo"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);

  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  await writeFile(path.join(repoDir, "file.txt"), `${lines.join("\n")}\n`, "utf8");
  git(repoDir, ["add", "file.txt"]);
  git(repoDir, ["commit", "-q", "-m", "base"]);

  // Agent edit: change line 10, capture the diff (with index lines), then revert.
  const edited = [...lines];
  edited[9] = "line 10 — AGENT CHANGE";
  await writeFile(path.join(repoDir, "file.txt"), `${edited.join("\n")}\n`, "utf8");
  const patchBody = git(repoDir, ["diff"]);
  git(repoDir, ["checkout", "--", "file.txt"]);

  // Upstream drift: change line 8 (a context line of the agent hunk) and commit.
  const drifted = [...lines];
  drifted[7] = "line 8 — UPSTREAM DRIFT";
  await writeFile(path.join(repoDir, "file.txt"), `${drifted.join("\n")}\n`, "utf8");
  git(repoDir, ["commit", "-q", "-am", "drift"]);

  const patchPath = path.join(workdir, "superlog.patch");
  await writeFile(patchPath, patchBody, "utf8");
  return { workdir, repoDir, patchPath };
}

test("applyAgentPatch 3-way-merges a patch whose context line drifted upstream", async () => {
  const { workdir, repoDir, patchPath } = await buildDriftedRepo();
  try {
    // Control: plain `git apply` (today's flags) cannot apply across the drift.
    const plain = spawnSync("git", ["apply", "--index", "--whitespace=nowarn", patchPath], {
      cwd: repoDir,
      encoding: "utf8",
    });
    assert.notEqual(plain.status, 0, "plain git apply should fail on context drift");

    // applyAgentPatch (--3way) merges the non-overlapping change in.
    await applyAgentPatch({ repoDir, patchPath });

    const result = await readFile(path.join(repoDir, "file.txt"), "utf8");
    assert.match(result, /line 10 — AGENT CHANGE/, "agent change must land");
    assert.match(result, /line 8 — UPSTREAM DRIFT/, "upstream drift must be preserved");
    assert.doesNotMatch(result, /<<<<<<<|>>>>>>>/, "no conflict markers");

    // The change is staged (--index), so the downstream commit step sees it.
    const staged = git(repoDir, ["diff", "--cached", "--name-only"]).trim();
    assert.equal(staged, "file.txt");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("applyAgentPatch throws on a genuinely conflicting patch", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "superlog-apply-test-"));
  const repoDir = path.join(workdir, "repo");
  try {
    git(workdir, ["init", "-q", "repo"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(repoDir, "file.txt"), "alpha\nbeta\ngamma\n", "utf8");
    git(repoDir, ["add", "file.txt"]);
    git(repoDir, ["commit", "-q", "-m", "base"]);

    // Agent rewrites line 2 → "beta-agent"; capture diff; revert.
    await writeFile(path.join(repoDir, "file.txt"), "alpha\nbeta-agent\ngamma\n", "utf8");
    const patchBody = git(repoDir, ["diff"]);
    git(repoDir, ["checkout", "--", "file.txt"]);

    // Upstream rewrites the SAME line 2 → "beta-upstream": a true conflict.
    await writeFile(path.join(repoDir, "file.txt"), "alpha\nbeta-upstream\ngamma\n", "utf8");
    git(repoDir, ["commit", "-q", "-am", "conflicting drift"]);

    const patchPath = path.join(workdir, "superlog.patch");
    await writeFile(patchPath, patchBody, "utf8");

    await assert.rejects(() => applyAgentPatch({ repoDir, patchPath }));
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});
