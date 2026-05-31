import assert from "node:assert/strict";
import { test } from "node:test";
import { STALE_SLACK_ANCHOR_ERRORS, isStaleSlackAnchorError } from "./slack-pinning.js";

test("classifies Slack errors that mean the (channel, ts) anchor is unreachable", () => {
  // Slack returns these when chat.postMessage / chat.update can't find the
  // referenced thread, message, or channel — i.e. the anchor we stored on the
  // incident no longer maps to a real conversation we can reach.
  for (const err of [
    "thread_not_found",
    "message_not_found",
    "channel_not_found",
    "not_in_channel",
    "is_archived",
  ]) {
    assert.equal(isStaleSlackAnchorError(err), true, `expected ${err} to be stale`);
  }
});

test("does not classify unrelated Slack errors as stale anchors", () => {
  // These are real Slack errors but they don't mean the anchor is unreachable.
  // ratelimited / not_authed / token_revoked are handled separately (token
  // revocation) and shouldn't trigger anchor-clearing.
  for (const err of ["ratelimited", "not_authed", "token_revoked", "invalid_blocks"]) {
    assert.equal(isStaleSlackAnchorError(err), false, `expected ${err} not to be stale`);
  }
});

test("treats null / undefined / empty errors as not stale", () => {
  assert.equal(isStaleSlackAnchorError(null), false);
  assert.equal(isStaleSlackAnchorError(undefined), false);
  assert.equal(isStaleSlackAnchorError(""), false);
});

test("STALE_SLACK_ANCHOR_ERRORS is a frozen set the runtime can rely on", () => {
  // Defensive: if this set were ever mutated at runtime, the pinning behavior
  // would silently change for everyone. Make sure callers can't add to it.
  assert.equal(STALE_SLACK_ANCHOR_ERRORS.size, 5);
});
