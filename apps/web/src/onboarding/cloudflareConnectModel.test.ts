import assert from "node:assert/strict";
import test from "node:test";
import {
  type CloudflarePhase,
  canContinueCloudflare,
  cloudflarePhase,
  cloudflareStatusText,
} from "./cloudflareConnectModel.ts";

test("phase starts at 'start' before the consent screen is opened", () => {
  assert.equal(cloudflarePhase({ installed: false, launched: false }), "start");
});

test("phase moves to 'connecting' once the consent screen is launched", () => {
  assert.equal(cloudflarePhase({ installed: false, launched: true }), "connecting");
});

test("phase is 'connected' as soon as the install lands, regardless of launch flag", () => {
  assert.equal(cloudflarePhase({ installed: true, launched: false }), "connected");
  assert.equal(cloudflarePhase({ installed: true, launched: true }), "connected");
});

test("Continue unlocks only when connected", () => {
  assert.equal(canContinueCloudflare("start"), false);
  assert.equal(canContinueCloudflare("connecting"), false);
  assert.equal(canContinueCloudflare("connected"), true);
});

test("status text reflects phase and whether events have arrived", () => {
  const phases: CloudflarePhase[] = ["start", "connecting", "connected"];
  for (const p of phases) {
    assert.equal(typeof cloudflareStatusText(p, false), "string");
  }
  assert.notEqual(
    cloudflareStatusText("connected", true),
    cloudflareStatusText("connected", false),
  );
});
