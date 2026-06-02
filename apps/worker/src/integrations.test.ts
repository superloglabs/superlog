import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  REVYL_INTEGRATION,
  buildCustomToolParams,
  executeIntegrationOperation,
} from "./integrations.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Revyl app listing operation calls the build vars endpoint with platform filter", async () => {
  const op = REVYL_INTEGRATION.operations.find((candidate) => candidate.name === "revyl_list_apps");
  assert.ok(op, "expected revyl_list_apps operation");

  let requestedUrl: string | null = null;
  let requestedAuth: string | null = null;
  globalThis.fetch = (async (url, init) => {
    requestedUrl = String(url);
    requestedAuth = String((init?.headers as Record<string, string>).Authorization);
    return new Response(
      JSON.stringify({
        items: [{ id: "app-1", name: "Juno Android", platform: "android", latest_version: "1" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await executeIntegrationOperation(
    {
      row: {} as never,
      definition: REVYL_INTEGRATION,
      secrets: { REVYL_API_KEY: "revyl_test_key" },
    },
    op,
    { platform: "android" },
    { incident_id: "incident-1", session_id: "session-1" },
  );

  assert.equal(
    requestedUrl,
    "https://backend.revyl.ai/api/v1/builds/vars?page=1&page_size=100&platform=android",
  );
  assert.equal(requestedAuth, "Bearer revyl_test_key");
  assert.deepEqual(result, {
    items: [{ id: "app-1", name: "Juno Android", platform: "android", latest_version: "1" }],
  });
});

test("Revyl run status operation is exposed with a compact response filter", () => {
  const op = REVYL_INTEGRATION.operations.find(
    (candidate) => candidate.name === "revyl_get_test_run",
  );
  assert.ok(op, "expected revyl_get_test_run operation");
  assert.equal(op.docs_only, undefined);

  const toolNames = buildCustomToolParams([
    {
      row: {} as never,
      definition: REVYL_INTEGRATION,
      secrets: { REVYL_API_KEY: "revyl_test_key" },
    },
  ]).map((tool) => tool.name);

  assert.ok(toolNames.includes("revyl_get_test_run"));
  assert.deepEqual(op.response_filter, [
    "status",
    "message",
    "result",
    "error",
    "report_url",
    "artifacts",
  ]);
});
