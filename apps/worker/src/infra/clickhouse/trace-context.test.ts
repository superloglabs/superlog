import assert from "node:assert/strict";
import { test } from "node:test";
import { traceContextTimeBounds } from "./trace-context.js";

const NOW = new Date("2026-07-13T16:00:00.000Z");

test("a hint timestamp bounds the window to ±1 hour around the event", () => {
  const hint = new Date("2026-07-10T02:30:00.000Z");
  const { fromMs, toMs } = traceContextTimeBounds(hint, NOW);
  assert.equal(fromMs, hint.getTime() - 60 * 60 * 1000);
  assert.equal(toMs, hint.getTime() + 60 * 60 * 1000);
});

test("no hint falls back to a 72-hour floor ending shortly after now", () => {
  const { fromMs, toMs } = traceContextTimeBounds(null, NOW);
  assert.equal(fromMs, NOW.getTime() - 72 * 60 * 60 * 1000);
  assert.equal(toMs, NOW.getTime() + 5 * 60 * 1000);
});

test("an invalid hint date falls back to the 72-hour floor", () => {
  const { fromMs, toMs } = traceContextTimeBounds(new Date("nonsense"), NOW);
  assert.equal(fromMs, NOW.getTime() - 72 * 60 * 60 * 1000);
  assert.equal(toMs, NOW.getTime() + 5 * 60 * 1000);
});
