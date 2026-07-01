import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isDeclaredEmptyBody } from "./empty-body-guard.js";

test("treats a Content-Length of exactly zero as a declared-empty body", () => {
  assert.equal(isDeclaredEmptyBody("0"), true);
});

test("passes through a non-zero Content-Length", () => {
  assert.equal(isDeclaredEmptyBody("1"), false);
  assert.equal(isDeclaredEmptyBody("42"), false);
  assert.equal(isDeclaredEmptyBody("1024"), false);
});

test("passes through when Content-Length is absent (chunked body)", () => {
  // No header → size is unknown, so we can't cheaply prove it's empty here. A
  // truly-empty chunked body still gets a 400 later via the body-capture path.
  assert.equal(isDeclaredEmptyBody(undefined), false);
  assert.equal(isDeclaredEmptyBody(null), false);
  assert.equal(isDeclaredEmptyBody(""), false);
});

test("ignores surrounding whitespace and leading zeros", () => {
  assert.equal(isDeclaredEmptyBody(" 0 "), true);
  assert.equal(isDeclaredEmptyBody("00"), true);
});

test("passes through a malformed Content-Length rather than rejecting it", () => {
  // Not our job to validate the header; only fast-reject a provably-empty body.
  // Anything non-numeric falls through to the normal path.
  assert.equal(isDeclaredEmptyBody("abc"), false);
  assert.equal(isDeclaredEmptyBody("0x0"), false);
  assert.equal(isDeclaredEmptyBody("0.5"), false);
  assert.equal(isDeclaredEmptyBody("-0"), false);
});
