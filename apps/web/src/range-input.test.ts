import assert from "node:assert/strict";
import test from "node:test";
import { parseRangeInput, parseRangeInputForVisibleRange } from "./design/range-input.ts";

test("parseRangeInput parses a local clock range on the current date", () => {
  const now = new Date(2026, 6, 16, 12, 34, 56, 789);
  const result = parseRangeInput("17:00-19:00", now.getTime());

  assert.deepEqual(result, {
    type: "absolute",
    range: {
      since: new Date(2026, 6, 16, 17, 0).toISOString(),
      until: new Date(2026, 6, 16, 19, 0).toISOString(),
    },
  });
});

test("parseRangeInput preserves relative duration input", () => {
  assert.deepEqual(parseRangeInput("last 30 minutes", Date.now()), {
    type: "relative",
    seconds: 30 * 60,
    label: "Last 30 minutes",
  });
});

test("clock ranges use the visible historical range date", () => {
  assert.deepEqual(
    parseRangeInputForVisibleRange(
      "17:00-19:00",
      {
        since: "2025-04-03T08:00:00.000Z",
        until: "2025-04-03T10:00:00.000Z",
      },
      new Date(2026, 6, 16, 12).getTime(),
    ),
    {
      type: "absolute",
      range: {
        since: new Date(2025, 3, 3, 17, 0).toISOString(),
        until: new Date(2025, 3, 3, 19, 0).toISOString(),
      },
    },
  );
});
