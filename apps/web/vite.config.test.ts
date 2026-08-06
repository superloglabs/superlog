import { strict as assert } from "node:assert";
import { test } from "node:test";
import { viteAllowedHosts } from "./vite.config.ts";

test("vite allows the generated Portless web host", () => {
  assert.deepEqual(viteAllowedHosts({ SUPERLOG_PORTLESS_WEB_HOST: "feature.superlog.local" }), [
    ".localhost",
    ".ngrok-free.app",
    ".ngrok.app",
    ".trycloudflare.com",
    "feature.superlog.local",
  ]);
});

test("vite keeps the default host allowlist outside Portless", () => {
  assert.deepEqual(viteAllowedHosts({}), [
    ".localhost",
    ".ngrok-free.app",
    ".ngrok.app",
    ".trycloudflare.com",
  ]);
});
