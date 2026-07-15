import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeGithubPullRequestWithToken, reopenGithubPullRequestWithToken } from "./github.js";

test("closeGithubPullRequestWithToken returns the provider state watermark", async () => {
  const result = await closeGithubPullRequestWithToken({
    token: "test-token",
    repoFullName: "acme/api",
    prNumber: 42,
    userAgent: "test",
    fetchImpl: async () => new Response('{"updated_at":"2026-07-15T11:04:30Z"}', { status: 200 }),
  });

  assert.deepEqual(result, {
    ok: true,
    providerUpdatedAt: new Date("2026-07-15T11:04:30Z"),
  });
});

test("reopenGithubPullRequestWithToken returns the provider state watermark", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const result = await reopenGithubPullRequestWithToken({
    token: "test-token",
    repoFullName: "acme/api",
    prNumber: 42,
    userAgent: "test",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response('{"updated_at":"2026-07-15T11:05:30Z"}', { status: 200 });
    },
  });

  assert.deepEqual(result, {
    ok: true,
    providerUpdatedAt: new Date("2026-07-15T11:05:30Z"),
  });
  assert.deepEqual(requests, [
    {
      url: "https://api.github.com/repos/acme/api/pulls/42",
      method: "PATCH",
      body: { state: "open" },
    },
  ]);
});
