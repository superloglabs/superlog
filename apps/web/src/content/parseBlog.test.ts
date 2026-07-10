import assert from "node:assert/strict";
import test from "node:test";
import { parseBlogPost } from "./parseBlog.ts";

const SAMPLE = `---
title: Weekly update
date: 2026-07-10
author: Arseniy
excerpt: What we shipped this week.
---

Hi there,

## A section

Some **markdown** body.`;

test("parses frontmatter into typed fields", () => {
  const post = parseBlogPost(SAMPLE, "weekly-update");
  assert.equal(post.slug, "weekly-update");
  assert.equal(post.title, "Weekly update");
  assert.equal(post.date, "2026-07-10");
  assert.equal(post.author, "Arseniy");
  assert.equal(post.excerpt, "What we shipped this week.");
});

test("body excludes the frontmatter block and is trimmed", () => {
  const post = parseBlogPost(SAMPLE, "weekly-update");
  assert.ok(post.body.startsWith("Hi there,"), "body should start after frontmatter");
  assert.ok(post.body.includes("## A section"));
  assert.ok(!post.body.includes("---"), "frontmatter delimiters must be stripped");
});

test("tolerates a colon in the value (only the first colon splits)", () => {
  const post = parseBlogPost(
    "---\ntitle: Quieter incidents: less noise\ndate: 2026-07-10\nauthor: ash\nexcerpt: x\n---\nBody.",
    "quieter",
  );
  assert.equal(post.title, "Quieter incidents: less noise");
});

test("missing author/excerpt default to empty strings", () => {
  const post = parseBlogPost("---\ntitle: T\ndate: 2026-07-10\n---\nBody.", "t");
  assert.equal(post.author, "");
  assert.equal(post.excerpt, "");
  assert.equal(post.title, "T");
});

test("throws when the frontmatter block is missing", () => {
  assert.throws(() => parseBlogPost("No frontmatter here.", "x"), /frontmatter/i);
});

test("throws when title or date is absent", () => {
  assert.throws(() => parseBlogPost("---\nauthor: ash\n---\nBody.", "x"), /title/i);
  assert.throws(() => parseBlogPost("---\ntitle: T\n---\nBody.", "x"), /date/i);
});
