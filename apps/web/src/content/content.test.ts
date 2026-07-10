import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parseBlogPost } from "./parseBlog.ts";
import { parseChangelog } from "./parseChangelog.ts";
import { parseRoadmap } from "./parseRoadmap.ts";

// Guards the shipped content files against authoring mistakes (e.g. a stray
// paragraph swallowed into a roadmap bullet, or a changelog heading missing its
// date). These are the actual files the pages import via `?raw`.

test("CHANGELOG.md parses into dated, titled entries", async () => {
  const raw = await readFile(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8");
  const entries = parseChangelog(raw);
  assert.ok(entries.length > 0, "expected at least one changelog entry");
  for (const entry of entries) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `entry "${entry.title}" needs an ISO date`);
    assert.ok(entry.title.length > 0, `entry ${entry.date} needs a title`);
    assert.ok(entry.body.length > 0, `entry "${entry.title}" needs a body`);
  }
});

test("changelog entries are ordered newest-first", async () => {
  const raw = await readFile(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8");
  const dates = parseChangelog(raw).map((e) => e.date);
  const sorted = [...dates].sort().reverse();
  assert.deepEqual(dates, sorted, "changelog entries must be newest-first");
});

test("every blog/*.md parses into a titled, dated post with a body", async () => {
  const dir = new URL("../../../../blog/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "expected at least one blog post");
  for (const file of files) {
    const raw = await readFile(new URL(file, dir), "utf8");
    const slug = file.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    const post = parseBlogPost(raw, slug);
    assert.match(post.date, /^\d{4}-\d{2}-\d{2}$/, `post "${file}" needs an ISO date`);
    assert.ok(post.title.length > 0, `post "${file}" needs a title`);
    assert.ok(post.body.length > 0, `post "${file}" needs a body`);
  }
});

test("ROADMAP.md parses into non-empty status columns", async () => {
  const raw = await readFile(new URL("../../../../ROADMAP.md", import.meta.url), "utf8");
  const sections = parseRoadmap(raw);
  assert.ok(sections.length > 0, "expected at least one roadmap section");
  assert.ok(
    sections.some((s) => s.items.length > 0),
    "expected at least one roadmap section with items",
  );
  // No stray prose should be glued onto a bullet — a long "item" is the tell.
  for (const section of sections) {
    for (const item of section.items) {
      assert.ok(item.length < 200, `roadmap item in "${section.status}" looks like merged prose`);
    }
  }
});
