import assert from "node:assert/strict";
import test from "node:test";
import { initialWebViewFromSearch, stripHandledOnboardingParams } from "./onboardingWebView.ts";

test("Vercel drains-unavailable callback opens prompt onboarding", () => {
  assert.equal(initialWebViewFromSearch("?vercel=drains_unavailable"), "code");
});

test("other Vercel callback outcomes resume the Vercel flow", () => {
  assert.equal(initialWebViewFromSearch("?vercel=installed"), "vercel");
  assert.equal(initialWebViewFromSearch("?vercel=denied"), "vercel");
  assert.equal(initialWebViewFromSearch("?vercel=error"), "vercel");
});

test("drains-unavailable is stripped after routing to prompt onboarding", () => {
  assert.equal(stripHandledOnboardingParams("?vercel=drains_unavailable"), "");
  assert.equal(stripHandledOnboardingParams("?vercel=drains_unavailable&x=1"), "?x=1");
  assert.equal(stripHandledOnboardingParams("?vercel=installed"), "?vercel=installed");
});
