import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { vercelCallbackView } from "./vercelCallbackModel.ts";

test("installed carries the outcome back so the wizard resumes the Vercel flow", () => {
  const view = vercelCallbackView("installed");
  assert.equal(view.tone, "success");
  assert.match(view.title, /connected/i);
  // The wizard reads `?vercel=` on `/` to drop into the flow's connected
  // panel instead of the integration chooser.
  assert.equal(view.backHref, "/app?vercel=installed");
});

test("drains_unavailable explains the prompt fallback", () => {
  const view = vercelCallbackView("drains_unavailable");
  assert.equal(view.tone, "error");
  assert.match(view.title, /drains aren't available/i);
  assert.match(view.body, /Pro or Enterprise/);
  assert.match(view.body, /Hobby|free/i);
  assert.match(view.body, /prompt/i);
  // Failure back-links carry the outcome so the onboarding wizard (which reads
  // `?vercel=` on `/`) can open the coding-agent prompt when the user returns.
  assert.equal(view.backHref, "/app?vercel=drains_unavailable");
});

test("denied and error return to the app with explicit retry guidance", () => {
  for (const outcome of ["denied", "error"] as const) {
    const view = vercelCallbackView(outcome);
    assert.equal(view.tone, "error");
    assert.match(view.body, /try again|reconnect/i);
    assert.equal(view.backHref, `/app?vercel=${outcome}`);
  }
});

test("unknown or missing outcomes fall back to a neutral error view", () => {
  for (const raw of [null, "", "bogus"]) {
    const view = vercelCallbackView(raw);
    assert.equal(view.tone, "error");
    assert.equal(view.backHref, "/app");
  }
});

test("the /connect/vercel route is registered as a public route", async () => {
  const appSource = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(appSource, /<Route path="\/connect\/vercel" element=\{<VercelCallback \/>\} \/>/);
});
