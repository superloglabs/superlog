import assert from "node:assert/strict";
import test from "node:test";
import { beginOrgSwitch, endOrgSwitch, isOrgSwitchingSnapshot } from "./org-switch-lock.ts";

test("no switch is in flight by default", () => {
  assert.equal(isOrgSwitchingSnapshot(), false);
});

test("begin marks a switch in flight; end clears it", () => {
  beginOrgSwitch();
  assert.equal(isOrgSwitchingSnapshot(), true);
  endOrgSwitch();
  assert.equal(isOrgSwitchingSnapshot(), false);
});

test("overlapping switches only clear when the last one ends", () => {
  beginOrgSwitch();
  beginOrgSwitch();
  assert.equal(isOrgSwitchingSnapshot(), true);
  endOrgSwitch();
  // Still locked — one switch is outstanding, so the route boundary must keep
  // deferring its reconcile.
  assert.equal(isOrgSwitchingSnapshot(), true);
  endOrgSwitch();
  assert.equal(isOrgSwitchingSnapshot(), false);
});

test("end never drives the counter negative", () => {
  endOrgSwitch();
  endOrgSwitch();
  assert.equal(isOrgSwitchingSnapshot(), false);
  // A subsequent begin still locks exactly once.
  beginOrgSwitch();
  assert.equal(isOrgSwitchingSnapshot(), true);
  endOrgSwitch();
  assert.equal(isOrgSwitchingSnapshot(), false);
});
