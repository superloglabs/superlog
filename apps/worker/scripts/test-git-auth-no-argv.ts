import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertSafeGitArgs } from "../src/github-app.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const files = [
  "apps/worker/src/github-app.ts",
  "scripts/push-and-open-pr.ts",
  "scripts/refresh-customer-pr.ts",
  "scripts/clone-with-app.ts",
];

for (const file of files) {
  const body = readFileSync(path.join(repoRoot, file), "utf8");
  assert.equal(
    /https:\/\/x-access-token:/.test(body),
    false,
    `${file} must not put GitHub tokens in URLs`,
  );
  assert.equal(
    /extraHeader=\$\{/.test(body),
    false,
    `${file} must not put GitHub auth headers in git -c argv`,
  );
  assert.equal(
    /git\s*\(\s*\[\s*["']push["'][\s\S]{0,120}pushUrl/.test(body),
    false,
    `${file} must not push through a token-bearing pushUrl`,
  );
  assert.equal(
    /GIT_(?:CURL_VERBOSE|TRACE(?:_CURL|_PACKET|_PERFORMANCE|_SETUP)?):\s*"0"/.test(body),
    false,
    `${file} must remove git trace env vars instead of setting them to "0"`,
  );
}

const agentRunWorker = readFileSync(path.join(repoRoot, "apps/worker/src/index.ts"), "utf8");
for (const banned of [
  "Cannot open a PR because GitHub repositories could not be listed: ${",
  "Failed to download patch file for PR: ${",
  "Failed to validate or open the PR: ${",
]) {
  assert.equal(
    agentRunWorker.includes(banned),
    false,
    "PR failure summaries persisted to agent_runs.result must not include raw exception text",
  );
}

assert.throws(
  () =>
    assertSafeGitArgs([
      "push",
      "https://x-access-token:ghs_should_never_be_in_argv@github.com/acme/repo.git",
      "HEAD:refs/heads/main",
    ]),
  /refusing to run git with credentials in argv/,
);
assert.throws(
  () =>
    assertSafeGitArgs([
      "-c",
      "http.https://github.com/.extraHeader=AUTHORIZATION: Basic abc123",
      "push",
      "origin",
      "HEAD:refs/heads/main",
    ]),
  /refusing to run git with credentials in argv/,
);
assert.doesNotThrow(() =>
  assertSafeGitArgs([
    "push",
    "https://github.com/acme/repo.git",
    "HEAD:refs/heads/superlog/obs-fix",
  ]),
);

console.log("git auth argv guard ok");
