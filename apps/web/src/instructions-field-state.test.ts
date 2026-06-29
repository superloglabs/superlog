import assert from "node:assert/strict";
import test from "node:test";
import { syncInstructionsDraft } from "./instructions-field-state.ts";

// Regression: the field used to seed its draft from `value` on first render,
// before the settings query resolved. On a cold page load `value` is "" while
// the query is pending, so the field locked in an empty draft and never picked
// up the real instructions when they arrived — showing an empty box (and, once
// expanded, an enabled Save button that would overwrite the saved text with "").

test("does not seed the draft before settings have loaded", () => {
  assert.equal(
    syncInstructionsDraft({
      loaded: false,
      settingsLoaded: false,
      serverValue: "",
      expanded: false,
    }),
    null,
  );
});

test("seeds the draft once settings load with existing instructions", () => {
  assert.deepEqual(
    syncInstructionsDraft({
      loaded: false,
      settingsLoaded: true,
      serverValue: "do not open PRs on local",
      expanded: false,
    }),
    { draft: "do not open PRs on local", loaded: true, expanded: true },
  );
});

test("seeds an empty draft without auto-expanding when there are no instructions", () => {
  assert.deepEqual(
    syncInstructionsDraft({
      loaded: false,
      settingsLoaded: true,
      serverValue: "",
      expanded: false,
    }),
    { draft: "", loaded: true, expanded: false },
  );
});

test("keeps the field expanded if the user already opened it", () => {
  assert.deepEqual(
    syncInstructionsDraft({
      loaded: false,
      settingsLoaded: true,
      serverValue: "",
      expanded: true,
    }),
    { draft: "", loaded: true, expanded: true },
  );
});

test("does not re-seed (clobber edits) once already loaded", () => {
  assert.equal(
    syncInstructionsDraft({
      loaded: true,
      settingsLoaded: true,
      serverValue: "fresh server value",
      expanded: true,
    }),
    null,
  );
});
