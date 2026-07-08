import assert from "node:assert/strict";
import test from "node:test";
import {
  canContinueRender,
  renderErrorMessage,
  renderPhase,
  renderStatusText,
} from "./renderConnectModel.ts";

test("phase progression: start → pick → connected", () => {
  assert.equal(renderPhase({ installed: false, ownersLoaded: false }), "start");
  assert.equal(renderPhase({ installed: false, ownersLoaded: true }), "pick");
  // Installed wins regardless of the picker state.
  assert.equal(renderPhase({ installed: true, ownersLoaded: false }), "connected");
  assert.equal(renderPhase({ installed: true, ownersLoaded: true }), "connected");
});

test("continue unlocks only when connected", () => {
  assert.equal(canContinueRender("start"), false);
  assert.equal(canContinueRender("pick"), false);
  assert.equal(canContinueRender("connected"), true);
});

test("API error codes map to actionable messages", () => {
  assert.match(
    renderErrorMessage(new Error('400: {"error":"invalid_key"}')),
    /rejected that API key/i,
  );
  assert.match(renderErrorMessage(new Error('400: {"error":"unknown_owner"}')), /isn't visible/i);
  assert.match(
    renderErrorMessage(new Error('502: {"error":"render_unavailable"}')),
    /reach Render/i,
  );
  assert.match(renderErrorMessage(new Error("boom")), /couldn't finish/i);
});

test("status text reflects the telemetry wait", () => {
  assert.match(renderStatusText("connected", false), /within a minute/i);
  assert.match(renderStatusText("connected", true), /arriving/i);
  assert.match(renderStatusText("pick", false), /pick the workspace/i);
});
