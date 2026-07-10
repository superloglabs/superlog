import assert from "node:assert/strict";
import test from "node:test";
import { formatStarCount, githubApiUrlFromRepoUrl } from "./githubStars.ts";

test("githubApiUrlFromRepoUrl maps a repo URL to the REST stars endpoint", () => {
  assert.equal(
    githubApiUrlFromRepoUrl("https://github.com/superloglabs/superlog"),
    "https://api.github.com/repos/superloglabs/superlog",
  );
});

test("githubApiUrlFromRepoUrl tolerates a trailing slash and .git suffix", () => {
  assert.equal(
    githubApiUrlFromRepoUrl("https://github.com/superloglabs/superlog/"),
    "https://api.github.com/repos/superloglabs/superlog",
  );
  assert.equal(
    githubApiUrlFromRepoUrl("https://github.com/superloglabs/superlog.git"),
    "https://api.github.com/repos/superloglabs/superlog",
  );
});

test("githubApiUrlFromRepoUrl returns null for non-repo GitHub URLs", () => {
  assert.equal(githubApiUrlFromRepoUrl("https://github.com/superloglabs"), null);
  assert.equal(githubApiUrlFromRepoUrl("https://example.com/a/b"), null);
  assert.equal(githubApiUrlFromRepoUrl("not a url"), null);
});

test("formatStarCount shows exact values below 1,000", () => {
  assert.equal(formatStarCount(0), "0");
  assert.equal(formatStarCount(1), "1");
  assert.equal(formatStarCount(947), "947");
  assert.equal(formatStarCount(999), "999");
});

test("formatStarCount abbreviates thousands with one decimal, trimming '.0'", () => {
  assert.equal(formatStarCount(1000), "1k");
  assert.equal(formatStarCount(1500), "1.5k");
  assert.equal(formatStarCount(10300), "10.3k");
  // Two-decimal inputs round to a single decimal.
  assert.equal(formatStarCount(12040), "12k");
  assert.equal(formatStarCount(12060), "12.1k");
});

test("formatStarCount abbreviates millions and never emits '1000k'", () => {
  assert.equal(formatStarCount(999_999), "1M");
  assert.equal(formatStarCount(1_000_000), "1M");
  assert.equal(formatStarCount(1_200_000), "1.2M");
});

test("formatStarCount is defensive about junk input", () => {
  assert.equal(formatStarCount(Number.NaN), "0");
  assert.equal(formatStarCount(-5), "0");
  assert.equal(formatStarCount(3.7), "3");
});
