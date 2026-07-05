import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { vercelCallbackView } from "./vercelCallbackModel.ts";

test("installed renders a success view that links home", () => {
  const view = vercelCallbackView("installed");
  assert.equal(view.tone, "success");
  assert.match(view.title, /connected/i);
  assert.equal(view.backHref, "/");
});

test("drains_unavailable spells out the Pro/Enterprise plan requirement", () => {
  const view = vercelCallbackView("drains_unavailable");
  assert.equal(view.tone, "error");
  assert.match(view.title, /drains aren't available/i);
  assert.match(view.body, /Pro or Enterprise/);
  assert.match(view.body, /Hobby|free/i);
  // Failure back-links carry the outcome so the onboarding wizard (which reads
  // `?vercel=` on `/`) resets out of its waiting state when the user returns.
  assert.equal(view.backHref, "/?vercel=drains_unavailable");
});

test("denied and error render explicit retry guidance", () => {
  for (const outcome of ["denied", "error"] as const) {
    const view = vercelCallbackView(outcome);
    assert.equal(view.tone, "error");
    assert.match(view.body, /try again|reconnect/i);
    assert.equal(view.backHref, `/?vercel=${outcome}`);
  }
});

test("unknown or missing outcomes fall back to a neutral error view", () => {
  for (const raw of [null, "", "bogus"]) {
    const view = vercelCallbackView(raw);
    assert.equal(view.tone, "error");
    assert.equal(view.backHref, "/");
  }
});

test("the /connect/vercel route is registered as a public route", async () => {
  const appSource = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(appSource, /<Route path="\/connect\/vercel" element=\{<VercelCallback \/>\} \/>/);
});
