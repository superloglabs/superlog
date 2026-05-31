import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatRetryBranchName,
  isGitPushBranchCollision,
  isMissingRemoteBranchFailure,
  isRetryableGitPushFailure,
  redactGitSecrets,
} from "./github-app.js";

test("redactGitSecrets scrubs GitHub installation/app tokens", () => {
  const token = "ghs_AbCdEf0123456789AbCdEf0123456789";
  const out = redactGitSecrets(`fatal: Authentication failed for ${token}`);
  assert.ok(!out.includes(token), "raw token must not survive");
  assert.match(out, /ghs_\*\*\*/);
});

test("redactGitSecrets scrubs gho/ghp/ghu tokens and fine-grained PATs", () => {
  assert.match(redactGitSecrets("ghp_AbCdEf0123456789AbCdEf0123456789"), /ghp_\*\*\*/);
  assert.match(redactGitSecrets("gho_AbCdEf0123456789AbCdEf0123456789"), /gho_\*\*\*/);
  const pat = "github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwxyz0123456789";
  const out = redactGitSecrets(pat);
  assert.ok(!out.includes(pat));
  assert.match(out, /github_pat_\*\*\*/);
});

test("redactGitSecrets scrubs x-access-token and basic auth headers", () => {
  const out = redactGitSecrets(
    "https://x-access-token:ghs_AbCdEf0123456789AbCdEf0123456789@github.com/o/r.git",
  );
  assert.ok(!out.includes("ghs_AbCdEf0123456789AbCdEf0123456789"));
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
    formatRetryBranchName("superlog/fix-refresh-token", "abcdef12-3456"),
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
