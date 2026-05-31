import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeAgentPatch } from "../src/github-app.js";

function run(command: string, cwd: string) {
  const result = spawnSync("bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Superlog Test",
      GIT_AUTHOR_EMAIL: "test@superlog.sh",
      GIT_COMMITTER_NAME: "Superlog Test",
      GIT_COMMITTER_EMAIL: "test@superlog.sh",
    },
  });
  assert.equal(
    result.status,
    0,
    [`command failed: ${command}`, result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  return result.stdout;
}

const dir = mkdtempSync(path.join(tmpdir(), "superlog-patch-normalize-"));
run("git init -q", dir);
writeFileSync(path.join(dir, "example.py"), "def answer():\n    value = 1\n    return value\n\n\n");
run("git add example.py && git commit -q -m baseline", dir);
writeFileSync(path.join(dir, "example.py"), "def answer():\n    value = 2\n    return value\n\n\n");

const rawPatch = run("git diff -- example.py", dir);
assert.match(rawPatch, /\n \n \n$/u, "fixture patch must end with whitespace-only context lines");

const normalized = normalizeAgentPatch(rawPatch);
assert.equal(
  normalized.slice(-4),
  " \n \n",
  "normalization must preserve trailing blank context lines",
);

run("git checkout -- example.py", dir);
writeFileSync(path.join(dir, "superlog.patch"), normalized);
run("git apply --index --whitespace=nowarn superlog.patch", dir);
assert.equal(readFileSync(path.join(dir, "example.py"), "utf8"), "def answer():\n    value = 2\n    return value\n\n\n");

const fenced = normalizeAgentPatch(`\`\`\`diff\n${rawPatch}\`\`\`\n`);
assert.equal(fenced, normalized, "fenced patches should unwrap without trimming patch content");

console.log("patch normalization ok");
