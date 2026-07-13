import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_FRAME_CLASS,
  PAGE_SCROLL_CONTAINER_CLASS,
  isDetailWorkspacePath,
} from "./route-layout.ts";

test("issue and incident detail routes use the full-width investigation workspace", () => {
  assert.equal(isDetailWorkspacePath("/issues/issue-1"), true);
  assert.equal(isDetailWorkspacePath("/incidents/incident-1"), true);
  assert.equal(isDetailWorkspacePath("/issues"), false);
  assert.equal(isDetailWorkspacePath("/settings"), false);
});

test("the app frame is pinned to the viewport so route content scrolls in its own region", () => {
  // Not `min-h-screen`: a min-height frame grows past the viewport and lets the
  // whole document scroll, so a route's inner overflow-y-auto never engages.
  assert.doesNotMatch(APP_FRAME_CLASS, /min-h-screen/);
  assert.match(APP_FRAME_CLASS, /h-\[100dvh\]/);
  assert.match(APP_FRAME_CLASS, /overflow-hidden/);
});

test("non-detail routes scroll inside their own container, not the document body", () => {
  assert.match(PAGE_SCROLL_CONTAINER_CLASS, /overflow-y-auto/);
  assert.match(PAGE_SCROLL_CONTAINER_CLASS, /min-h-0/);
  assert.match(PAGE_SCROLL_CONTAINER_CLASS, /flex-1/);
});
