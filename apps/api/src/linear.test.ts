import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

test("buildLinearAuthorizeUrl requests app-actor authorization", async () => {
  const { buildLinearAuthorizeUrl } = await import("./linear.js");
  const url = new URL(
    buildLinearAuthorizeUrl({
      clientId: "lin-client",
      redirectUrl: "https://api.superlog.sh/linear/oauth/callback",
      state: "signed-state",
    }),
  );

  assert.equal(url.origin + url.pathname, "https://linear.app/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "lin-client");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://api.superlog.sh/linear/oauth/callback",
  );
  assert.equal(url.searchParams.get("scope"), "read,write,issues:create,comments:create");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("actor"), "app");
});
