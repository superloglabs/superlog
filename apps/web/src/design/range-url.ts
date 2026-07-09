// Pure helpers for representing an absolute time window in the Explore URL.
// The range picker itself works in live "last N" presets (RangePicker.tsx),
// but a page can be deep-linked (e.g. from an incident's telemetry query) to a
// fixed absolute window via `?since=…&until=…`. Kept in a JSX-free module so it
// can be unit-tested with `node --test`.

import type { ExploreRange } from "../api.ts";

// Label shown on the picker trigger when the range is a fixed absolute window
// rather than a live "last N" preset.
export const CUSTOM_RANGE_LABEL = "Custom";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/** True when `s` is an absolute ISO timestamp with a real calendar date/time.
 *  Guards against `Date.parse` silently normalizing impossible inputs — it
 *  rolls `2026-02-31` forward to March instead of rejecting it — by validating
 *  the month/day (leap-aware) and time components directly. */
function isCalendarTimestamp(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
  return day >= 1 && day <= daysInMonth;
}

/** Validate a pair of URL `since`/`until` values into a fixed absolute range.
 *  Requires both bounds to be absolute ISO timestamps with real calendar
 *  dates forming a positive window; rejects missing bounds, ClickHouse time
 *  expressions (`now() - …`), impossible dates, and inverted/empty ranges so a
 *  malformed URL falls back to the default preset instead of pinning a
 *  nonsense window. */
export function parseAbsoluteRange(
  since: string | null | undefined,
  until: string | null | undefined,
): ExploreRange | null {
  if (!since || !until) return null;
  if (!isCalendarTimestamp(since) || !isCalendarTimestamp(until)) return null;
  const s = Date.parse(since);
  const u = Date.parse(until);
  if (!Number.isFinite(s) || !Number.isFinite(u) || s >= u) return null;
  return { since, until };
}
