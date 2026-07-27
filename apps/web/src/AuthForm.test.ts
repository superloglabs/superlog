import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("every auth attempt refreshes the attribution cookie before it leaves the page", async () => {
  // The API's user-create hook reads PostHog ids from this cookie to
  // session-attribute the server-side signup event; each auth path must
  // snapshot fresh ids first (a social "sign-in" can create a new user too).
  const source = await readFile(new URL("./AuthForm.tsx", import.meta.url), "utf8");

  assert.match(source, /refreshSignupAttributionCookie\(posthog, \{ authMethod: "email" \}\)/);
  assert.match(source, /refreshSignupAttributionCookie\(posthog, \{ authMethod: "google" \}\)/);
  assert.match(source, /refreshSignupAttributionCookie\(posthog, \{ authMethod: "github" \}\)/);
});

test("social sign-in accepts a caller-provided callback URL", async () => {
  const source = await readFile(new URL("./AuthForm.tsx", import.meta.url), "utf8");

  assert.match(source, /socialCallbackURL\?: string/);
  assert.match(source, /callbackURL: socialCallbackURL \?\? `\$\{window\.location\.origin\}\/app`/);
  assert.match(
    source,
    /callbackURL: socialCallbackURL \?\? `\$\{API_URL\}\/api\/github\/post-signin`/,
  );
});
