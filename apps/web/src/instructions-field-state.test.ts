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
      settingsLoaded: false,
      serverValue: "",
      draft: "",
      syncedValue: null,
      expanded: false,
    }),
    null,
  );
});

test("seeds the draft once settings load with existing instructions", () => {
  assert.deepEqual(
    syncInstructionsDraft({
      settingsLoaded: true,
      serverValue: "do not open PRs on local",
      draft: "",
      syncedValue: null,
      expanded: false,
    }),
    { draft: "do not open PRs on local", syncedValue: "do not open PRs on local", expanded: true },
  );
});

test("seeds an empty draft without auto-expanding when there are no instructions", () => {
  assert.deepEqual(
    syncInstructionsDraft({
      settingsLoaded: true,
      serverValue: "",
      draft: "",
      syncedValue: null,
      expanded: false,
    }),
    { draft: "", syncedValue: "", expanded: false },
  );
});

test("keeps the field expanded if the user already opened it", () => {
  assert.deepEqual(
    syncInstructionsDraft({
      settingsLoaded: true,
      serverValue: "",
      draft: "",
      syncedValue: null,
      expanded: true,
    }),
    { draft: "", syncedValue: "", expanded: true },
  );
});

test("does nothing when already reconciled to the current server value", () => {
  assert.equal(
    syncInstructionsDraft({
      settingsLoaded: true,
      serverValue: "rules",
      draft: "rules",
      syncedValue: "rules",
      expanded: true,
    }),
    null,
  );
});

test("a clean editor follows a newer server value (background refetch / edit elsewhere)", () => {
  assert.deepEqual(
    syncInstructionsDraft({
      settingsLoaded: true,
      serverValue: "updated rules",
      draft: "old rules",
      syncedValue: "old rules",
      expanded: true,
    }),
    { draft: "updated rules", syncedValue: "updated rules", expanded: true },
  );
});

test("does not clobber unsaved local edits when the server changes underneath", () => {
  assert.equal(
    syncInstructionsDraft({
      settingsLoaded: true,
      serverValue: "updated rules",
      draft: "my work-in-progress edit",
      syncedValue: "old rules",
      expanded: true,
    }),
    null,
  );
});

test("reconciles bookkeeping (without touching the draft) once the server catches up to the draft", () => {
  // After the user's own save lands, the refetched server value equals the
  // draft. We advance syncedValue so the editor is clean again, but leave the
  // draft alone.
  assert.deepEqual(
    syncInstructionsDraft({
      settingsLoaded: true,
      serverValue: "my saved rules",
      draft: "my saved rules",
      syncedValue: "old rules",
      expanded: true,
    }),
    { draft: "my saved rules", syncedValue: "my saved rules", expanded: true },
  );
});
