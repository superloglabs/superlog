import { strict as assert } from "node:assert";
import test from "node:test";
import { SupabaseManagementClient } from "./client.js";

test("database metrics queries use Supabase's read-only Management API endpoint", async () => {
  const captured: { request?: { url: string; init: RequestInit } } = {};
  const client = new SupabaseManagementClient(async (input, init) => {
    captured.request = { url: input.toString(), init: init ?? {} };
    return new Response(JSON.stringify([{ queryid: "42", calls: "7" }]), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });

  const rows = await client.runReadOnlyQuery({
    accessToken: "access-token",
    projectRef: "abcdefghijklmnopqrst",
    query: "select 1",
  });

  assert.deepEqual(rows, [{ queryid: "42", calls: "7" }]);
  const request = captured.request;
  assert.ok(request);
  assert.equal(
    request.url,
    "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query/read-only",
  );
  assert.equal(request.init.method, "POST");
  assert.equal(
    (request.init.headers as Record<string, string>).authorization,
    "Bearer access-token",
  );
  assert.equal(request.init.body, JSON.stringify({ query: "select 1" }));
});

test("OAuth code exchange keeps the refresh token needed by the scheduled puller", async () => {
  const captured: { body?: URLSearchParams } = {};
  const client = new SupabaseManagementClient(async (_input, init) => {
    captured.body = init?.body as URLSearchParams;
    return new Response(
      JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200 },
    );
  });

  const token = await client.exchangeCode({
    config: {
      clientId: "66666666-6666-4666-8666-666666666666",
      clientSecret: "client-secret",
      redirectUri: "https://api.example.com/supabase/oauth/callback",
    },
    code: "authorization-code",
  });

  assert.deepEqual(token, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresInSeconds: 3600,
  });
  const body = captured.body;
  assert.ok(body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "authorization-code");
});

test("project discovery returns every hosted project visible to the OAuth account", async () => {
  const client = new SupabaseManagementClient(async (input) => {
    assert.equal(input.toString(), "https://api.supabase.com/v1/projects");
    return new Response(
      JSON.stringify([
        {
          ref: "abcdefghijklmnopqrst",
          name: "Production",
          organization_slug: "acme",
          region: "eu-west-1",
          status: "ACTIVE_HEALTHY",
          database: { host: "db.example.supabase.co" },
        },
        {
          ref: "zyxwvutsrqponmlkjihg",
          name: "Staging",
          organization_slug: "acme-labs",
          region: "us-east-1",
          status: "INACTIVE",
          database: { host: "db.staging.supabase.co" },
        },
      ]),
      { status: 200 },
    );
  });

  assert.deepEqual(await client.listProjects("access-token"), [
    {
      ref: "abcdefghijklmnopqrst",
      name: "Production",
      organizationSlug: "acme",
      region: "eu-west-1",
      status: "ACTIVE_HEALTHY",
      databaseHost: "db.example.supabase.co",
    },
    {
      ref: "zyxwvutsrqponmlkjihg",
      name: "Staging",
      organizationSlug: "acme-labs",
      region: "us-east-1",
      status: "INACTIVE",
      databaseHost: "db.staging.supabase.co",
    },
  ]);
});

test("refreshing a Supabase grant preserves a non-rotated refresh token", async () => {
  const client = new SupabaseManagementClient(async (_input, init) => {
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "original-refresh-token");
    return new Response(
      JSON.stringify({
        access_token: "fresh-access-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200 },
    );
  });

  const token = await client.refreshAccessToken({
    config: {
      clientId: "66666666-6666-4666-8666-666666666666",
      clientSecret: "client-secret",
      redirectUri: "https://api.example.com/supabase/oauth/callback",
    },
    refreshToken: "original-refresh-token",
  });

  assert.deepEqual(token, {
    accessToken: "fresh-access-token",
    refreshToken: "original-refresh-token",
    expiresInSeconds: 3600,
  });
});

test("profile lookup identifies the Supabase account independently of its projects", async () => {
  const client = new SupabaseManagementClient(async (input) => {
    assert.equal(input.toString(), "https://api.supabase.com/v1/profile");
    return new Response(
      JSON.stringify({
        gotrue_id: "supabase-user-1",
        primary_email: "owner@example.com",
        username: "Owner",
      }),
      { status: 200 },
    );
  });

  assert.deepEqual(await client.getProfile("access-token"), {
    userId: "supabase-user-1",
    primaryEmail: "owner@example.com",
    username: "Owner",
  });
});
