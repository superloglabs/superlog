import assert from "node:assert/strict";
import { test } from "node:test";
import { routeSentryOAuthCallback } from "./oauth-routing.js";

const allowedDestination = "https://responder.example.test/api/integrations/sentry/callback";

function responderState(destination: string): string {
  return `responder-v1.${Buffer.from(destination, "utf8").toString("base64url")}.nonce`;
}

test("rejects malformed and disallowed Responder callback destinations", () => {
  const cases = [
    "responder-v1.%%%.nonce",
    responderState("https://attacker.example.test/api/integrations/sentry/callback"),
    responderState("https://responder.example.test/api/integrations/sentry/other"),
    responderState("https://user:password@responder.example.test/api/integrations/sentry/callback"),
    responderState(
      "https://responder.example.test/api/integrations/sentry/callback?next=https://attacker.example.test",
    ),
    responderState("https://responder.example.test/api/integrations/sentry/callback#attacker"),
    responderState(
      "https://responder.example.test@attacker.example.test/api/integrations/sentry/callback",
    ),
  ];

  for (const state of cases) {
    assert.deepEqual(
      routeSentryOAuthCallback({
        state,
        requestUrl: `https://api.example.test/sentry/oauth/callback?state=${state}`,
        allowedDestination,
      }),
      { kind: "invalid" },
      state,
    );
  }
});
