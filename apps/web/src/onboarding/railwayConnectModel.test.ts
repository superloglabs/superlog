import assert from "node:assert/strict";
import test from "node:test";
import {
  canContinueRailway,
  parseRailwayOutcome,
  railwayOutcomeMessage,
  railwayPhase,
  railwayStatusText,
} from "./railwayConnectModel.ts";

test("phase starts at 'start' before the consent screen is opened", () => {
  assert.equal(railwayPhase({ installed: false, launched: false }), "start");
});

test("phase moves to 'connecting' once the consent screen is launched", () => {
  assert.equal(railwayPhase({ installed: false, launched: true }), "connecting");
});

test("phase is 'connected' as soon as the install lands, regardless of launch flag", () => {
  assert.equal(railwayPhase({ installed: true, launched: false }), "connected");
  assert.equal(railwayPhase({ installed: true, launched: true }), "connected");
});

test("Continue unlocks only when connected", () => {
  assert.equal(canContinueRailway("start"), false);
  assert.equal(canContinueRailway("connecting"), false);
  assert.equal(canContinueRailway("connected"), true);
});

test("outcome parsing accepts only known outcomes", () => {
  assert.equal(parseRailwayOutcome("installed"), "installed");
  assert.equal(parseRailwayOutcome("denied"), "denied");
  assert.equal(parseRailwayOutcome("error"), "error");
  assert.equal(parseRailwayOutcome("no_projects"), "no_projects");
  assert.equal(parseRailwayOutcome("surprise"), null);
  assert.equal(parseRailwayOutcome(null), null);
});

test("failure outcomes carry a user-facing message; success does not", () => {
  assert.equal(railwayOutcomeMessage("installed"), null);
  assert.equal(railwayOutcomeMessage(null), null);
  for (const outcome of ["denied", "error", "no_projects"] as const) {
    const message = railwayOutcomeMessage(outcome);
    assert.ok(message && message.length > 0, `${outcome} needs a message`);
  }
  assert.match(railwayOutcomeMessage("no_projects") ?? "", /select at least one project/i);
});

test("status text reflects pull-based ingestion once connected", () => {
  assert.match(railwayStatusText("connected", false), /pulling logs and metrics/i);
  assert.match(railwayStatusText("connected", true), /arriving/i);
  assert.match(railwayStatusText("connecting", false), /Railway tab/i);
});
