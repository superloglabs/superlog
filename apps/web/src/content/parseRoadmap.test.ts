import assert from "node:assert/strict";
import test from "node:test";
import { parseRoadmap } from "./parseRoadmap.ts";

test("splits into sections keyed by heading, each with its bullet items", () => {
  const sections = parseRoadmap(`# Roadmap

Intro that is ignored.

## Now

- **Episodes** — group alert firings
- Better dashboards

## Next

- Anomaly detection`);
  assert.equal(sections.length, 2);
  assert.equal(sections[0]!.status, "Now");
  assert.deepEqual(sections[0]!.items, ["**Episodes** — group alert firings", "Better dashboards"]);
  assert.equal(sections[1]!.status, "Next");
  assert.deepEqual(sections[1]!.items, ["Anomaly detection"]);
});

test("supports both - and * bullet markers", () => {
  const sections = parseRoadmap(`## Later

* one
- two`);
  assert.deepEqual(sections[0]!.items, ["one", "two"]);
});

test("joins wrapped continuation lines into a single item", () => {
  const sections = parseRoadmap(`## Now

- A longer item that
  wraps across two lines`);
  assert.deepEqual(sections[0]!.items, ["A longer item that wraps across two lines"]);
});

test("keeps a section with no items as an empty column", () => {
  const sections = parseRoadmap(`## Now

- something

## Next
`);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[1]!.items, []);
});

test("returns an empty array for empty or headingless input", () => {
  assert.deepEqual(parseRoadmap(""), []);
  assert.deepEqual(parseRoadmap("no headings here"), []);
});
