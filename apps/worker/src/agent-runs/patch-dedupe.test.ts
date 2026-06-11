import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findRejectedDuplicatePatch, hashAgentPatch } from "./patch-dedupe.js";

const PATCH = `diff --git a/src/worker.ts b/src/worker.ts
index 1111111..2222222 100644
--- a/src/worker.ts
+++ b/src/worker.ts
@@ -1,3 +1,3 @@
-const retryLimit = 1;
+const retryLimit = 3;
`;

function fakeDb(rows: Array<{ prNumber: number; url: string }>) {
  const wheres: unknown[] = [];
  const database = {
    select() {
      return {
        from() {
          return {
            where(condition: unknown) {
              wheres.push(condition);
              return {
                orderBy() {
                  return {
                    async limit() {
                      return rows;
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { database, wheres };
}

test("hashAgentPatch is stable across normalization-equivalent patches", () => {
  const direct = hashAgentPatch(PATCH);
  const fenced = hashAgentPatch(`\`\`\`diff\n${PATCH}\n\`\`\`\n`);
  const crlf = hashAgentPatch(PATCH.replaceAll("\n", "\r\n"));
  assert.match(direct, /^[0-9a-f]{64}$/);
  assert.equal(fenced, direct);
  assert.equal(crlf, direct);
  assert.notEqual(hashAgentPatch(PATCH.replace("3;", "5;")), direct);
});

test("findRejectedDuplicatePatch returns the closed-unmerged twin", async () => {
  const { database } = fakeDb([{ prNumber: 41, url: "https://github.com/o/r/pull/41" }]);
  const found = await findRejectedDuplicatePatch({
    database: database as never,
    repoFullName: "o/r",
    patchHash: hashAgentPatch(PATCH),
  });
  assert.deepEqual(found, { prNumber: 41, url: "https://github.com/o/r/pull/41" });
});

test("findRejectedDuplicatePatch returns null when no twin exists", async () => {
  const { database } = fakeDb([]);
  const found = await findRejectedDuplicatePatch({
    database: database as never,
    repoFullName: "o/r",
    patchHash: hashAgentPatch(PATCH),
  });
  assert.equal(found, null);
});
