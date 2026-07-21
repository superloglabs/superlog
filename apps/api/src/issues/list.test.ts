import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildIssueListItems, parseIssueListWindow } from "./list.js";

test("issue list defaults to errors seen during the last 12 days", () => {
  assert.deepEqual(parseIssueListWindow(undefined), { days: 12 });
  assert.deepEqual(parseIssueListWindow("12"), { days: 12 });
});

test("issue list can show errors from any time", () => {
  assert.deepEqual(parseIssueListWindow("all"), { days: null });
});

test("issue list rejects unsupported recency windows", () => {
  assert.throws(() => parseIssueListWindow("0"), /between 1 and 90 days/);
  assert.throws(() => parseIssueListWindow("91"), /between 1 and 90 days/);
  assert.throws(() => parseIssueListWindow("recent"), /between 1 and 90 days/);
});

test("issue list exposes a continuous 12-day frequency series for every error", () => {
  const rows = buildIssueListItems(
    [
      {
        id: "issue-1",
        fingerprint: "fp-1",
        eventCount: 21,
        lastSeen: new Date("2026-07-20T08:00:00.000Z"),
      },
      {
        id: "issue-2",
        fingerprint: "fp-2",
        eventCount: 3,
        lastSeen: new Date("2026-07-19T08:00:00.000Z"),
      },
    ],
    [
      { fingerprint: "fp-1", day: "2026-07-19", count: 4 },
      { fingerprint: "fp-1", day: "2026-07-20", count: "17" },
      { fingerprint: "fp-2", day: "2026-07-18", count: 3 },
    ],
    { now: new Date("2026-07-21T12:00:00.000Z"), windowDays: 12 },
  );

  assert.equal(rows[0]?.activityBuckets.length, 12);
  assert.equal(rows[0]?.activityBuckets[0]?.day, "2026-07-10");
  assert.equal(rows[0]?.activityBuckets.find((bucket) => bucket.day === "2026-07-19")?.count, 4);
  assert.equal(rows[0]?.activityBuckets.find((bucket) => bucket.day === "2026-07-20")?.count, 17);
  assert.equal(rows[1]?.activityBuckets.find((bucket) => bucket.day === "2026-07-18")?.count, 3);
});
