import { strict as assert } from "node:assert";
import { test } from "node:test";

// Pure-function tests; the service transitively imports the db client which
// connects lazily, so a dummy URL keeps import-time side effects happy without
// opening a socket. Same pattern as alerts-service.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { sanitizeClauseList, sanitizeIssueFilterConfig, mergeIssueFilterConfig } = await import(
  "./issue-filter-service.js"
);

const EMPTY = {
  includeLogs: [],
  includeSpans: [],
  excludeLogs: [],
  excludeSpans: [],
};

test("sanitizeClauseList trims, drops empties, and ignores non-objects", () => {
  assert.deepEqual(
    sanitizeClauseList([
      { key: "  service.name ", value: " checkout " },
      { key: "", value: "x" },
      { key: "x", value: "" },
      "nonsense",
      null,
      42,
    ]),
    [{ key: "service.name", value: "checkout" }],
  );
});

test("sanitizeClauseList dedupes case-insensitively by key", () => {
  assert.deepEqual(
    sanitizeClauseList([
      { key: "Service.Name", value: "checkout" },
      { key: "service.name", value: "checkout" },
      { key: "service.name", value: "billing" },
    ]),
    [
      { key: "Service.Name", value: "checkout" },
      { key: "service.name", value: "billing" },
    ],
  );
});

test("sanitizeClauseList caps at 20 clauses", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, value: "v" }));
  assert.equal(sanitizeClauseList(many).length, 20);
});

test("sanitizeClauseList caps key/value length", () => {
  const [clause] = sanitizeClauseList([{ key: "k".repeat(500), value: "v".repeat(900) }]);
  assert.equal(clause?.key.length, 200);
  assert.equal(clause?.value.length, 400);
});

test("sanitizeClauseList returns [] for non-arrays", () => {
  assert.deepEqual(sanitizeClauseList(undefined), []);
  assert.deepEqual(sanitizeClauseList({ key: "x", value: "y" }), []);
});

test("sanitizeIssueFilterConfig falls back when input is not an object", () => {
  const fallback = { ...EMPTY, includeLogs: [{ key: "a", value: "b" }] };
  assert.equal(sanitizeIssueFilterConfig(null, fallback), fallback);
  assert.equal(sanitizeIssueFilterConfig("nope", fallback), fallback);
});

test("sanitizeIssueFilterConfig sanitizes each bucket, missing buckets become []", () => {
  const result = sanitizeIssueFilterConfig(
    { includeSpans: [{ key: "http.route", value: "/pay" }] },
    { ...EMPTY, excludeLogs: [{ key: "stale", value: "1" }] },
  );
  assert.deepEqual(result, {
    includeLogs: [],
    includeSpans: [{ key: "http.route", value: "/pay" }],
    excludeLogs: [],
    excludeSpans: [],
  });
});

test("mergeIssueFilterConfig only replaces buckets present in the patch", () => {
  const current = {
    includeLogs: [{ key: "keep", value: "1" }],
    includeSpans: [],
    excludeLogs: [{ key: "drop-me", value: "1" }],
    excludeSpans: [],
  };
  const merged = mergeIssueFilterConfig(current, {
    excludeLogs: [{ key: "noise", value: "x" }],
  });
  assert.deepEqual(merged, {
    includeLogs: [{ key: "keep", value: "1" }],
    includeSpans: [],
    excludeLogs: [{ key: "noise", value: "x" }],
    excludeSpans: [],
  });
});

test("mergeIssueFilterConfig can clear a bucket with an empty array", () => {
  const current = { ...EMPTY, excludeLogs: [{ key: "noise", value: "x" }] };
  const merged = mergeIssueFilterConfig(current, { excludeLogs: [] });
  assert.deepEqual(merged.excludeLogs, []);
});
