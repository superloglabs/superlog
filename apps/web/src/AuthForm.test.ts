import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("social sign-in accepts a caller-provided callback URL", async () => {
  const source = await readFile(new URL("./AuthForm.tsx", import.meta.url), "utf8");

  assert.match(source, /socialCallbackURL\?: string/);
  assert.match(source, /callbackURL: socialCallbackURL \?\? `\$\{window\.location\.origin\}\/app`/);
  assert.match(
    source,
    /callbackURL: socialCallbackURL \?\? `\$\{API_URL\}\/api\/github\/post-signin`/,
  );
});
