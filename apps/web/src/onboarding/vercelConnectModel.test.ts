import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  VERCEL_PLAN_REQUIREMENT,
  type VercelPhase,
  canContinueVercel,
  parseVercelOutcome,
  vercelOutcomeMessage,
  vercelPhase,
  vercelStatusText,
} from "./vercelConnectModel.ts";

test("phase starts at 'start' before the install screen is opened", () => {
  assert.equal(vercelPhase({ installed: false, launched: false }), "start");
});

test("phase moves to 'connecting' once the install screen is launched", () => {
  assert.equal(vercelPhase({ installed: false, launched: true }), "connecting");
});

test("phase is 'connected' as soon as the install lands, regardless of launch flag", () => {
  assert.equal(vercelPhase({ installed: true, launched: false }), "connected");
  assert.equal(vercelPhase({ installed: true, launched: true }), "connected");
});

test("Continue unlocks only when connected", () => {
  assert.equal(canContinueVercel("start"), false);
  assert.equal(canContinueVercel("connecting"), false);
  assert.equal(canContinueVercel("connected"), true);
});

test("status text reflects phase and whether events have arrived", () => {
  const phases: VercelPhase[] = ["start", "connecting", "connected"];
  for (const p of phases) {
    assert.equal(typeof vercelStatusText(p, false), "string");
  }
  assert.notEqual(vercelStatusText("connected", true), vercelStatusText("connected", false));
});

test("parseVercelOutcome only accepts the known callback values", () => {
  assert.equal(parseVercelOutcome("installed"), "installed");
  assert.equal(parseVercelOutcome("denied"), "denied");
  assert.equal(parseVercelOutcome("error"), "error");
  assert.equal(parseVercelOutcome("drains_unavailable"), "drains_unavailable");
  assert.equal(parseVercelOutcome("bogus"), null);
  assert.equal(parseVercelOutcome(null), null);
  assert.equal(parseVercelOutcome(undefined), null);
});

test("only failure outcomes produce a user-facing message", () => {
  assert.equal(typeof vercelOutcomeMessage("denied"), "string");
  assert.equal(typeof vercelOutcomeMessage("error"), "string");
  assert.match(vercelOutcomeMessage("drains_unavailable") ?? "", /Pro or Enterprise/);
  assert.equal(vercelOutcomeMessage("installed"), null);
  assert.equal(vercelOutcomeMessage(null), null);
});

test("the plan requirement names the eligible tiers and the gated one", () => {
  assert.match(VERCEL_PLAN_REQUIREMENT, /Pro or Enterprise/);
  assert.match(VERCEL_PLAN_REQUIREMENT, /Hobby/);
});

test("both pre-connect surfaces render the shared plan-requirement copy", async () => {
  // Onboarding wizard start panel and the settings Vercel card must both show
  // the plan gate BEFORE the user launches the install — a Hobby-team user
  // otherwise only learns about it after a failed OAuth round-trip.
  const flow = await readFile(new URL("./VercelConnectFlow.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../Settings.tsx", import.meta.url), "utf8");
  assert.match(flow, /VERCEL_PLAN_REQUIREMENT/);
  assert.match(settings, /VERCEL_PLAN_REQUIREMENT/);
});
