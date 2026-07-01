import assert from "node:assert/strict";
import test from "node:test";
import { parseChangelog } from "./parseChangelog.ts";

test("parses a single dated entry with a title", () => {
  const entries = parseChangelog(`# Changelog

Intro paragraph that is ignored.

## 2026-07-01 — Alert Episodes

We shipped alert episodes.`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.date, "2026-07-01");
  assert.equal(entries[0]!.title, "Alert Episodes");
  assert.equal(entries[0]!.body, "We shipped alert episodes.");
  assert.deepEqual(entries[0]!.tags, []);
});

test("supports a plain hyphen separator between date and title", () => {
  const entries = parseChangelog(`## 2026-06-01 - Dashboard variables

Body.`);
  assert.equal(entries[0]!.date, "2026-06-01");
  assert.equal(entries[0]!.title, "Dashboard variables");
});

test("extracts a leading Tags: line and strips it from the body", () => {
  const entries = parseChangelog(`## 2026-07-01 — Episodes

Tags: Feature, Alerts

The body starts here.`);
  assert.deepEqual(entries[0]!.tags, ["Feature", "Alerts"]);
  assert.equal(entries[0]!.body, "The body starts here.");
});

test("keeps document order (newest first is the author's responsibility)", () => {
  const entries = parseChangelog(`## 2026-07-01 — Newest

a

## 2026-06-01 — Older

b`);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["Newest", "Older"],
  );
});

test("tolerates a heading with no date", () => {
  const entries = parseChangelog(`## Unreleased

Coming soon.`);
  assert.equal(entries[0]!.date, "");
  assert.equal(entries[0]!.title, "Unreleased");
  assert.equal(entries[0]!.body, "Coming soon.");
});

test("returns an empty array for empty or headingless input", () => {
  assert.deepEqual(parseChangelog(""), []);
  assert.deepEqual(parseChangelog("just some prose, no headings"), []);
});

test("preserves markdown (lists, links) inside the body", () => {
  const entries = parseChangelog(`## 2026-07-01 — Thing

- one
- two

See [docs](https://example.com).`);
  assert.match(entries[0]!.body, /- one\n- two/);
  assert.match(entries[0]!.body, /\[docs\]\(https:\/\/example\.com\)/);
});
