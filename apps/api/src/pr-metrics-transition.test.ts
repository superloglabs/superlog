import { strict as assert } from "node:assert";
import { test } from "node:test";
import { prTerminalTransition } from "./pr-metrics-transition.js";

test("counts a merge when an open PR is closed-as-merged", () => {
  assert.equal(
    prTerminalTransition({ action: "closed", merged: true, prevState: "open" }),
    "merged",
  );
});

test("counts a close-without-merge when an open PR is closed unmerged", () => {
  assert.equal(
    prTerminalTransition({ action: "closed", merged: false, prevState: "open" }),
    "closed",
  );
});

test("does not count non-terminal actions", () => {
  for (const action of ["opened", "reopened", "edited", "synchronize", "ready_for_review"]) {
    assert.equal(prTerminalTransition({ action, merged: false, prevState: "open" }), null);
    assert.equal(prTerminalTransition({ action, merged: true, prevState: "open" }), null);
  }
});

test("does not re-count a merge already recorded (webhook re-delivery)", () => {
  assert.equal(prTerminalTransition({ action: "closed", merged: true, prevState: "merged" }), null);
});

test("does not re-count a close already recorded (webhook re-delivery)", () => {
  assert.equal(
    prTerminalTransition({ action: "closed", merged: false, prevState: "closed" }),
    null,
  );
});

test("counts a merge after a prior close (closed → reopened → merged lands once)", () => {
  // The PR was closed unmerged, reopened, then merged. The merge is a fresh
  // terminal transition relative to the 'closed' prior state, so it counts.
  assert.equal(
    prTerminalTransition({ action: "closed", merged: true, prevState: "closed" }),
    "merged",
  );
});

test("counts a close after a prior merge state only as a fresh transition", () => {
  // Defensive: if a PR somehow goes merged → reopened → closed-unmerged, the
  // close is a fresh transition relative to 'merged'.
  assert.equal(
    prTerminalTransition({ action: "closed", merged: false, prevState: "merged" }),
    "closed",
  );
});
