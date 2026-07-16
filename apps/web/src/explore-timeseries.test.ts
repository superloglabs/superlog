import assert from "node:assert/strict";
import test from "node:test";
import {
  bucketSeriesSpansDates,
  formatBucketAxisTick,
  rangeFromBucketSelection,
} from "./explore-timeseries.ts";
import { formatLocalTimestamp } from "./timeFormat.ts";

test("rangeFromBucketSelection selects complete histogram buckets", () => {
  assert.deepEqual(
    rangeFromBucketSelection("2026-07-16 17:00:00", "2026-07-16 18:00:00", "1 HOUR", {
      since: "2026-07-16T16:00:00.000Z",
      until: "2026-07-16T20:00:00.000Z",
    }),
    {
      since: "2026-07-16T17:00:00.000Z",
      until: "2026-07-16T19:00:00.000Z",
    },
  );
});

test("rangeFromBucketSelection never expands beyond the current range", () => {
  assert.deepEqual(
    rangeFromBucketSelection("2026-07-16 17:00:00", "2026-07-16 19:00:00", "1 HOUR", {
      since: "2026-07-16T17:15:00.000Z",
      until: "2026-07-16T19:30:00.000Z",
    }),
    {
      since: "2026-07-16T17:15:00.000Z",
      until: "2026-07-16T19:30:00.000Z",
    },
  );
});

test("bucket axis ticks include dates when the series spans multiple local dates", () => {
  const buckets = ["2026-07-15 12:00:00", "2026-07-17 12:00:00"];
  const firstBucket = buckets[0];
  assert.ok(firstBucket);

  assert.equal(bucketSeriesSpansDates(buckets), true);
  assert.equal(
    formatBucketAxisTick(firstBucket, true),
    formatLocalTimestamp(firstBucket).slice(5, 16),
  );
});
