import { strict as assert } from "node:assert";
import test from "node:test";
import {
  SUPABASE_OAUTH_SCOPES,
  buildSupabaseAuthorizeUrl,
  supabaseConfigFromEnv,
} from "./oauth.js";

test("Supabase authorization requests only project discovery and read-only database access", () => {
  const url = new URL(
    buildSupabaseAuthorizeUrl({
      clientId: "66666666-6666-4666-8666-666666666666",
      redirectUri: "https://api.example.com/supabase/oauth/callback",
      state: "signed-state",
    }),
  );

  assert.equal(url.origin + url.pathname, "https://api.supabase.com/v1/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "projects:read database:read");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(SUPABASE_OAUTH_SCOPES, "projects:read database:read");
});

test("Supabase OAuth stays disabled until both client credentials are configured", () => {
  assert.equal(supabaseConfigFromEnv({}), null);
  assert.equal(supabaseConfigFromEnv({ SUPABASE_CLIENT_ID: "client-id" }), null);
  assert.deepEqual(
    supabaseConfigFromEnv({
      SUPABASE_CLIENT_ID: "client-id",
      SUPABASE_CLIENT_SECRET: "client-secret",
    }),
    {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:4100/supabase/oauth/callback",
    },
  );
});
