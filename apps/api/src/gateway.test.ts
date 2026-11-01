import "dotenv/config";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { db } from "@superlog/db";
import { Hono } from "hono";
import { mountGateway } from "./gateway.js";

test("legacy LLM gateway routes are unavailable to authenticated CLI sessions", async () => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  const cliSessions = db.query.cliSessions as unknown as {
    findFirst: () => Promise<{
      id: string;
      userId: string;
      orgId: string;
      revokedAt: Date | null;
      expiresAt: Date | null;
    }>;
  };
  const users = db.query.users as unknown as {
    findFirst: () => Promise<{ id: string; email: string }>;
  };
  const orgs = db.query.orgs as unknown as {
    findFirst: () => Promise<{ id: string; name: string }>;
  };
  const database = db as unknown as {
    update: () => { set: () => { where: () => Promise<void> } };
  };
  const previousFindSession = cliSessions.findFirst;
  const previousFindUser = users.findFirst;
  const previousFindOrg = orgs.findFirst;
  const previousUpdate = database.update;

  cliSessions.findFirst = async () => ({
    id: "session-1",
    userId: "user-1",
    orgId: "org-1",
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  users.findFirst = async () => ({ id: "user-1", email: "user@example.com" });
  orgs.findFirst = async () => ({ id: "org-1", name: "Test org" });
  database.update = () => ({ set: () => ({ where: async () => {} }) });
  process.env.ANTHROPIC_API_KEY = "test-shared-key";
  globalThis.fetch = async () => new Response("unexpected upstream response", { status: 200 });

  try {
    const app = new Hono();
    mountGateway(app, {} as ClickHouseClient);

    const catchAllResponse = await app.request("/v1/models", {
      headers: { authorization: "Bearer superlog_cli_test-token" },
    });
    assert.equal(catchAllResponse.status, 404);

    const messagesResponse = await app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer superlog_cli_test-token" },
    });
    assert.equal(messagesResponse.status, 404);
  } finally {
    cliSessions.findFirst = previousFindSession;
    users.findFirst = previousFindUser;
    orgs.findFirst = previousFindOrg;
    database.update = previousUpdate;
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
  }
});

test("device user codes do not come from Math.random", async () => {
  const previousRandom = Math.random;
  Math.random = () => 0;

  try {
    const app = new Hono();
    mountGateway(app, {} as ClickHouseClient);

    const issue = async () => {
      const res = await app.request("/oauth/device", { method: "POST" });
      return ((await res.json()) as { user_code: string }).user_code;
    };

    assert.notEqual(await issue(), await issue());
  } finally {
    Math.random = previousRandom;
  }
});
