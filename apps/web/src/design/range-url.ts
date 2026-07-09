// Pure helpers for representing an absolute time window in the Explore URL.
// The range picker itself works in live "last N" presets (RangePicker.tsx),
// but a page can be deep-linked (e.g. from an incident's telemetry query) to a
// fixed absolute window via `?since=…&until=…`. Kept in a JSX-free module so it
// can be unit-tested with `node --test`.

import type { ExploreRange } from "../api.ts";

// Label shown on the picker trigger when the range is a fixed absolute window
// rather than a live "last N" preset.
export const CUSTOM_RANGE_LABEL = "Custom";

const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Validate a pair of URL `since`/`until` values into a fixed absolute range.
 *  Requires both bounds to be absolute ISO timestamps forming a positive
 *  window; rejects missing bounds, ClickHouse time expressions (`now() - …`),
 *  and inverted/empty ranges so a malformed URL falls back to the default
 *  preset instead of pinning a nonsense window. */
export function parseAbsoluteRange(
  since: string | null | undefined,
  until: string | null | undefined,
): ExploreRange | null {
  if (!since || !until) return null;
  if (!ISO_RE.test(since) || !ISO_RE.test(until)) return null;
  const s = Date.parse(since);
  const u = Date.parse(until);
  if (!Number.isFinite(s) || !Number.isFinite(u) || s >= u) return null;
  return { since, until };
}
