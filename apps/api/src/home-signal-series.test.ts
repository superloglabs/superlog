import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeHomeSignalSeriesRows } from "./home-signal-series.js";

test("home signal series merges traces, logs, and metrics into chronological chart points", () => {
  const series = mergeHomeSignalSeriesRows([
    { bucket: "2026-07-21 10:05:00", signal: "logs", count: "14" },
    { bucket: "2026-07-21 10:00:00", signal: "traces", count: 9 },
    { bucket: "2026-07-21 10:00:00", signal: "metrics", count: "21" },
    { bucket: "2026-07-21 10:05:00", signal: "traces", count: 11 },
  ]);

  assert.deepEqual(series, [
    { bucket: "2026-07-21 10:00:00", traces: 9, logs: 0, metrics: 21 },
    { bucket: "2026-07-21 10:05:00", traces: 11, logs: 14, metrics: 0 },
  ]);
});
