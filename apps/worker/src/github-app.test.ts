import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type GithubDirEntry,
  MAX_REPO_INSTRUCTION_FILES,
  applyAgentPatch,
  buildPullRequestDeliveryCommitMessage,
  collectRepoInstructionFiles,
  commitMessageHasPullRequestDelivery,
  findPullRequestDeliveryCommit,
  formatRetryBranchName,
  isGitPushBranchCollision,
  isMissingRemoteBranchFailure,
  isRetryableGitPushFailure,
  openedAgentPullRequest,
  recoverPullRequestDelivery,
  redactGitSecrets,
} from "./github-app.js";

function makeDirLister(
  dirs: Record<string, GithubDirEntry[]>,
): (dirPath: string) => Promise<GithubDirEntry[] | null> {
  return async (dirPath: string) => dirs[dirPath] ?? null;
}

function file(path: string): GithubDirEntry {
  return { name: path.split("/").at(-1) ?? path, path, type: "file" };
}

function dir(path: string): GithubDirEntry {
  return { name: path.split("/").at(-1) ?? path, path, type: "dir" };
}

test("collectRepoInstructionFiles finds root-level instruction files", async () => {
  const found = await collectRepoInstructionFiles(
    makeDirLister({
      "": [file("CLAUDE.md"), file("AGENTS.md"), file(".cursorrules"), file("README.md")],
    }),
  );
  assert.deepEqual(found, ["CLAUDE.md", "AGENTS.md", ".cursorrules"]);
});

test("collectRepoInstructionFiles matches instruction file names case-insensitively", async () => {
  const found = await collectRepoInstructionFiles(
    makeDirLister({ "": [file("claude.md"), file("Agents.md")] }),
  );
  assert.deepEqual(found, ["claude.md", "Agents.md"]);
});

test("collectRepoInstructionFiles lists .cursor/rules contents when .cursor exists", async () => {
  const found = await collectRepoInstructionFiles(
    makeDirLister({
      "": [dir(".cursor"), file("README.md")],
      ".cursor/rules": [file(".cursor/rules/logging.mdc"), dir(".cursor/rules/backend")],
    }),
  );
  assert.deepEqual(found, [".cursor/rules/logging.mdc", ".cursor/rules/backend/"]);
});

test("collectRepoInstructionFiles finds .github/copilot-instructions.md", async () => {
  const found = await collectRepoInstructionFiles(
    makeDirLister({
      "": [dir(".github")],
      ".github": [file(".github/copilot-instructions.md"), file(".github/CODEOWNERS")],
    }),
  );
  assert.deepEqual(found, [".github/copilot-instructions.md"]);
});

test("collectRepoInstructionFiles skips directory probes when the root lacks them", async () => {
  const probed: string[] = [];
  const found = await collectRepoInstructionFiles(async (dirPath) => {
    probed.push(dirPath);
    return dirPath === "" ? [file("README.md"), dir("src")] : [];
  });
  assert.deepEqual(found, []);
  assert.deepEqual(probed, [""]);
});

test("collectRepoInstructionFiles returns empty when the root listing fails", async () => {
  const found = await collectRepoInstructionFiles(async () => null);
  assert.deepEqual(found, []);
});

test("collectRepoInstructionFiles ignores directories named like instruction files", async () => {
  const found = await collectRepoInstructionFiles(makeDirLister({ "": [dir("CLAUDE.md")] }));
  assert.deepEqual(found, []);
});

test("collectRepoInstructionFiles caps the result list", async () => {
  const rules = Array.from({ length: 40 }, (_, i) => file(`.cursor/rules/rule-${i}.mdc`));
  const found = await collectRepoInstructionFiles(
    makeDirLister({ "": [dir(".cursor")], ".cursor/rules": rules }),
  );
  assert.equal(found.length, MAX_REPO_INSTRUCTION_FILES);
});

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

test("a pull request delivery marker is opaque, exact, and preserves the resolved base", () => {
  const message = buildPullRequestDeliveryCommitMessage(
    "Fix API retries",
    "d4e5f60718293a4b",
    "release/2026-07",
  );

  assert.equal(
    message,
    "Fix API retries\n\nDelivery-Id: d4e5f60718293a4b\nDelivery-Base: release/2026-07",
  );
  assert.equal(commitMessageHasPullRequestDelivery(message, "d4e5f60718293a4b"), true);
  assert.equal(commitMessageHasPullRequestDelivery(message, "d4e5f60718293a4"), false);
});

test("existing-branch recovery matches the exact delivery marker, not an id prefix", () => {
  assert.deepEqual(
    findPullRequestDeliveryCommit(
      [
        {
          sha: "wrong",
          message: "Fix API retries\n\nDelivery-Id: d4e5f60718293a4b-extra",
        },
        {
          sha: "right",
          message: "Fix API retries\n\nDelivery-Id: d4e5f60718293a4b",
        },
      ],
      "d4e5f60718293a4b",
    ),
    { sha: "right", message: "Fix API retries\n\nDelivery-Id: d4e5f60718293a4b" },
  );
});

test("delivery recovery finds a merged PR even after its branch was deleted", async () => {
  const lookedUpBranches: string[] = [];
  const recovered = await recoverPullRequestDelivery({
    deliveryId: "d4e5f60718293a4b",
    requestedBranch: "ash/fix-api",
    lookup: {
      async listPullRequests(branchName) {
        lookedUpBranches.push(branchName);
        return branchName === "ash/fix-api-retry-d4e5f607"
          ? [
              {
                prUrl: "https://github.com/acme/api/pull/42",
                prNumber: 42,
                prNodeId: "PR_42",
                headSha: "abc123",
                branchName,
                baseBranch: "main",
                state: "closed",
                mergedAt: "2026-07-14T12:00:00Z",
                authorLogin: "octocat",
                authorGithubId: 1,
                authorAvatarUrl: null,
              },
            ]
          : [];
      },
      async listPullRequestCommitMessages(prNumber) {
        assert.equal(prNumber, 42);
        return ["Fix API retries\n\nDelivery-Id: d4e5f60718293a4b"];
      },
      async getBranchHead() {
        return null;
      },
    },
  });

  assert.deepEqual(lookedUpBranches, ["ash/fix-api", "ash/fix-api-retry-d4e5f607"]);
  assert.equal(recovered?.kind, "pull_request");
  if (recovered?.kind !== "pull_request") return;
  assert.equal(recovered.pullRequest.prNumber, 42);
  assert.equal(recovered.pullRequest.state, "closed");

  const opened = openedAgentPullRequest(recovered.pullRequest);
  assert.equal(opened.state, "merged");
  assert.deepEqual(opened.mergedAt, new Date("2026-07-14T12:00:00Z"));
});

test("delivery recovery resumes a pushed branch that has no PR yet", async () => {
  const recovered = await recoverPullRequestDelivery({
    deliveryId: "d4e5f60718293a4b",
    requestedBranch: "ash/fix-api",
    lookup: {
      async listPullRequests() {
        return [];
      },
      async listPullRequestCommitMessages() {
        return [];
      },
      async getBranchHead(branchName) {
        return branchName === "ash/fix-api"
          ? {
              headSha: "abc123",
              commitMessage:
                "Fix API retries\n\nDelivery-Id: d4e5f60718293a4b\nDelivery-Base: development",
            }
          : null;
      },
    },
  });

  assert.deepEqual(recovered, {
    kind: "branch",
    branchName: "ash/fix-api",
    headSha: "abc123",
    baseBranch: "development",
  });
});

test("an occupied deterministic fallback without the delivery marker is not adopted", async () => {
  const recovered = await recoverPullRequestDelivery({
    deliveryId: "d4e5f60718293a4b",
    requestedBranch: "ash/fix-api",
    lookup: {
      async listPullRequests() {
        return [];
      },
      async listPullRequestCommitMessages() {
        return [];
      },
      async getBranchHead() {
        return { headSha: "someone-elses-sha", commitMessage: "Unrelated work" };
      },
    },
  });

  assert.equal(recovered, null);
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
