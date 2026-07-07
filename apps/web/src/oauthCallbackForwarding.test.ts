import assert from "node:assert/strict";
import test from "node:test";
import { externalOAuthCallbackForwardUrl } from "./oauthCallbackForwarding.ts";

test("forwards Vercel OAuth callbacks from the web origin to the API origin", () => {
  assert.equal(
    externalOAuthCallbackForwardUrl(
      { pathname: "/vercel/oauth/callback", search: "?code=c&state=s&teamId=t" },
      "https://api.superlog.sh/",
    ),
    "https://api.superlog.sh/vercel/oauth/callback?code=c&state=s&teamId=t",
  );
});

test("ignores non-Vercel callback paths", () => {
  assert.equal(
    externalOAuthCallbackForwardUrl(
      { pathname: "/settings", search: "?vercel=connected" },
      "https://api.superlog.sh",
    ),
    null,
  );
});
