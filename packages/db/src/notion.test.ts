import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { exchangeNotionCode, notionOwnerEmail } = await import("./notion.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("exchangeNotionCode posts an authorization_code grant with Basic auth", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(
      JSON.stringify({
        access_token: "secret_tok",
        bot_id: "bot_1",
        workspace_id: "ws_1",
        workspace_name: "Acme",
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const token = await exchangeNotionCode({
    clientId: "cid",
    clientSecret: "csecret",
    code: "the_code",
    redirectUri: "https://api.example.com/notion/oauth/callback",
  });

  assert.equal(token.access_token, "secret_tok");
  assert.equal(token.workspace_id, "ws_1");
  assert.ok(captured);
  const { url, init } = captured as { url: string; init: RequestInit };
  assert.equal(url, "https://api.notion.com/v1/oauth/token");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
  assert.deepEqual(JSON.parse(init.body as string), {
    grant_type: "authorization_code",
    code: "the_code",
    redirect_uri: "https://api.example.com/notion/oauth/callback",
  });
});

test("exchangeNotionCode throws on a non-2xx response", async () => {
  globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
  await assert.rejects(
    exchangeNotionCode({
      clientId: "cid",
      clientSecret: "csecret",
      code: "x",
      redirectUri: "https://api.example.com/cb",
    }),
    /notion oauth exchange failed: 400/,
  );
});

test("notionOwnerEmail digs the connecting user's email out of the token", () => {
  assert.equal(
    notionOwnerEmail({
      access_token: "t",
      bot_id: "b",
      workspace_id: "w",
      owner: { type: "user", user: { person: { email: "dev@acme.com" } } },
    }),
    "dev@acme.com",
  );
  assert.equal(notionOwnerEmail({ access_token: "t", bot_id: "b", workspace_id: "w" }), null);
});
