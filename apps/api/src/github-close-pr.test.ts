import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";

const { closeGithubPullRequestWithInstallations, closeGithubPullRequestWithToken } = await import(
  "./github.js"
);

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

test("closeGithubPullRequestWithToken closes by node id before repo URL fallback", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input.toString()}`);
    assert.equal(JSON.parse(init?.body as string).variables.pullRequestId, "PR_node_1");
    return jsonResponse({ data: { closePullRequest: { pullRequest: { id: "PR_node_1" } } } });
  };

  const result = await closeGithubPullRequestWithToken({
    token: "token",
    repoFullName: "old-owner/old-repo",
    prNumber: 241,
    prNodeId: "PR_node_1",
    userAgent: "test",
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["POST https://api.github.com/graphql"]);
});

test("closeGithubPullRequestWithToken falls back to repo URL when node close fails", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input.toString()}`);
    if (input.toString().endsWith("/graphql")) {
      return jsonResponse({ errors: [{ message: "not found" }] });
    }
    assert.equal(init?.body, JSON.stringify({ state: "closed" }));
    return jsonResponse({ state: "closed" });
  };

  const result = await closeGithubPullRequestWithToken({
    token: "token",
    repoFullName: "current-owner/current-repo",
    prNumber: 241,
    prNodeId: "PR_node_1",
    userAgent: "test",
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    "POST https://api.github.com/graphql",
    "PATCH https://api.github.com/repos/current-owner/current-repo/pulls/241",
  ]);
});

test("closeGithubPullRequestWithInstallations tries fallback installations", async () => {
  const tokenAttempts: number[] = [];
  const requests: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ method: init?.method ?? "GET", url: String(input) });
    assert.equal(
      init?.headers && new Headers(init.headers).get("authorization"),
      "Bearer token-202",
    );
    if ((init?.method ?? "GET") === "GET") {
      return jsonResponse({
        state: "closed",
        merged: false,
        updated_at: "2026-07-15T11:04:30Z",
        closed_at: "2026-07-15T11:04:30Z",
        merged_at: null,
        merged_by: null,
      });
    }
    return jsonResponse({
      data: {
        closePullRequest: {
          pullRequest: { id: "PR_node_1", updatedAt: "2026-07-15T11:04:30Z" },
        },
      },
    });
  };

  const result = await closeGithubPullRequestWithInstallations({
    installationIds: [101, 202],
    repoFullName: "old-owner/old-repo",
    prNumber: 241,
    prNodeId: "PR_node_1",
    userAgent: "test",
    fetchImpl,
    createWriteToken: async (installationId) => {
      tokenAttempts.push(installationId);
      if (installationId === 101) throw new Error("github POST /access_tokens failed: 404");
      return "token-202";
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(typeof result.loadAuthoritativeObservation, "function");
  const authoritative = await result.loadAuthoritativeObservation?.();
  assert.equal(authoritative?.targetState, "closed");
  assert.equal(authoritative?.providerUpdatedAt?.toISOString(), "2026-07-15T11:04:30.000Z");
  assert.deepEqual(tokenAttempts, [101, 202]);
  assert.deepEqual(requests, [
    { method: "POST", url: "https://api.github.com/graphql" },
    {
      method: "GET",
      url: "https://api.github.com/repos/old-owner/old-repo/pulls/241",
    },
  ]);
});
