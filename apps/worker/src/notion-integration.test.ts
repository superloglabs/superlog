import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { NOTION_INTEGRATION, buildNotionResolvedIntegration } = await import(
  "./notion-integration.js"
);
const { executeIntegrationOperation } = await import("./integrations.js");
import type { NotionInstallation } from "@superlog/db";

const INSTALL = {
  id: "inst-1",
  projectId: "proj-1",
  botId: "bot-1",
  workspaceId: "ws-1",
  workspaceName: "Acme",
  workspaceIcon: null,
  accessToken: "secret_tok",
  actorUserId: null,
  actorEmail: null,
  reauthRequiredAt: null,
  reauthReason: null,
  revokedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} satisfies NotionInstallation;

const resolved = buildNotionResolvedIntegration(INSTALL, "org-1");
const opByName = (name: string) => {
  const op = NOTION_INTEGRATION.operations.find((o) => o.name === name);
  if (!op) throw new Error(`no op ${name}`);
  return op;
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch(responseBody: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
  return calls;
}

function firstCall(calls: Array<{ url: string; init: RequestInit }>) {
  const call = calls[0];
  assert.ok(call, "expected a fetch call");
  return call;
}

test("buildNotionResolvedIntegration feeds the grant token as the integration secret", () => {
  assert.equal(resolved.secrets.NOTION_ACCESS_TOKEN, "secret_tok");
  assert.equal(resolved.definition.slug, "notion");
  assert.equal(resolved.row.orgId, "org-1");
});

test("notion_search POSTs /v1/search with bearer + version headers and prunes absent fields", async () => {
  const calls = captureFetch({ results: [], next_cursor: null, has_more: false });
  await executeIntegrationOperation(
    resolved,
    opByName("notion_search"),
    { query: "payments runbook", page_size: 10 },
    { incident_id: "i", session_id: "s" },
  );
  assert.equal(calls.length, 1);
  const { url, init } = firstCall(calls);
  assert.equal(url, "https://api.notion.com/v1/search");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer secret_tok");
  assert.equal(headers["Notion-Version"], "2022-06-28");
  assert.deepEqual(JSON.parse(init.body as string), {
    query: "payments runbook",
    page_size: 10,
  });
});

test("notion_get_page substitutes the page id into the path and sends no body", async () => {
  const calls = captureFetch({ object: "page", id: "pg-1" });
  await executeIntegrationOperation(
    resolved,
    opByName("notion_get_page"),
    { page_id: "pg-1" },
    { incident_id: "i", session_id: "s" },
  );
  const getPage = firstCall(calls);
  assert.equal(getPage.url, "https://api.notion.com/v1/pages/pg-1");
  assert.equal(getPage.init.method, "GET");
  assert.equal(getPage.init.body, undefined);
});

test("notion_get_page_content reads block children with an optional page_size query", async () => {
  const calls = captureFetch({ results: [], has_more: false });
  await executeIntegrationOperation(
    resolved,
    opByName("notion_get_page_content"),
    { block_id: "pg-1", page_size: 50 },
    { incident_id: "i", session_id: "s" },
  );
  const content = firstCall(calls);
  assert.equal(content.url, "https://api.notion.com/v1/blocks/pg-1/children?page_size=50");
  assert.equal(content.init.method, "GET");
});
