import assert from "node:assert/strict";
import test from "node:test";
import { canContinueGcp, gcpPhase, gcpStatusText } from "./gcpConnectModel.ts";

test("gcpPhase starts at 'start' with no connection and no launch", () => {
  assert.equal(gcpPhase({ status: null, launched: false }), "start");
});

test("gcpPhase moves to 'connecting' once the consent screen is opened", () => {
  assert.equal(gcpPhase({ status: null, launched: true }), "connecting");
});

test("gcpPhase treats an in-flight provisioning row as 'connecting'", () => {
  assert.equal(gcpPhase({ status: "pending", launched: false }), "connecting");
  assert.equal(gcpPhase({ status: "provisioning", launched: false }), "connecting");
});

test("gcpPhase reaches 'connected' once the row is connected", () => {
  assert.equal(gcpPhase({ status: "connected", launched: true }), "connected");
  assert.equal(gcpPhase({ status: "connected", launched: false }), "connected");
});

test("gcpPhase surfaces 'failed' regardless of launch state", () => {
  assert.equal(gcpPhase({ status: "failed", launched: true }), "failed");
  assert.equal(gcpPhase({ status: "failed", launched: false }), "failed");
});

test("canContinueGcp only unlocks on 'connected'", () => {
  assert.equal(canContinueGcp("start"), false);
  assert.equal(canContinueGcp("connecting"), false);
  assert.equal(canContinueGcp("failed"), false);
  assert.equal(canContinueGcp("connected"), true);
});

test("gcpStatusText reflects the phase and telemetry arrival", () => {
  assert.match(gcpStatusText("connecting", false), /authorize Google Cloud/);
  assert.match(gcpStatusText("connected", true), /arriving/);
  assert.match(gcpStatusText("connected", false), /within a minute/);
});
