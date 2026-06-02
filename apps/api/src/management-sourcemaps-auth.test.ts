import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DB } from "@superlog/db";
import { resolvePublicSourceMapUploadAuth } from "./management-auth.js";

function databaseReturning(row: { id: string; projectId: string } | null): DB {
  return {
    query: {
      apiKeys: {
        async findFirst() {
          return row;
        },
      },
    },
  } as unknown as DB;
}

test("public ingest keys can authorize source map uploads for their own project", async () => {
  const projectId = randomUUID();
  const auth = await resolvePublicSourceMapUploadAuth({
    database: databaseReturning({ id: "key-1", projectId }),
    method: "POST",
    path: `/api/v1/projects/${projectId}/sourcemaps`,
    token: "sl_public_test-token",
  });

  assert.deepEqual(auth, { projectId, apiKeyId: "key-1" });
});

test("public ingest keys cannot upload source maps for another project", async () => {
  const auth = await resolvePublicSourceMapUploadAuth({
    database: databaseReturning({ id: "key-1", projectId: randomUUID() }),
    method: "POST",
    path: `/api/v1/projects/${randomUUID()}/sourcemaps`,
    token: "sl_public_test-token",
  });

  assert.equal(auth, null);
});

test("public ingest keys do not authorize other management API routes", async () => {
  const projectId = randomUUID();
  const auth = await resolvePublicSourceMapUploadAuth({
    database: databaseReturning({ id: "key-1", projectId }),
    method: "GET",
    path: `/api/v1/projects/${projectId}/api-keys`,
    token: "sl_public_test-token",
  });

  assert.equal(auth, null);
});
