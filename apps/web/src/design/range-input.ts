import type { ExploreRange } from "../api.ts";

export type ParsedRangeInput =
  | { type: "absolute"; range: ExploreRange }
  | { type: "relative"; seconds: number; label: string };

const CLOCK_RANGE_RE = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/;

const UNIT_SECS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
};

export function parseRangeInput(input: string, now: number): ParsedRangeInput | null {
  const trimmed = input.trim();
  const match = CLOCK_RANGE_RE.exec(trimmed);
  if (!match) {
    const cleaned = trimmed.toLowerCase().replace(/^(last|past)\s+/, "");
    const duration = cleaned.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
    if (!duration) return null;
    const [, amountInput, unit] = duration;
    if (!amountInput || !unit) return null;
    const amount = Number.parseFloat(amountInput);
    const multiplier = UNIT_SECS[unit];
    if (!multiplier || !Number.isFinite(amount) || amount <= 0) return null;
    return {
      type: "relative",
      seconds: amount * multiplier,
      label: `Last ${cleaned}`,
    };
  }

  const sinceHour = Number(match[1]);
  const sinceMinute = Number(match[2]);
  const untilHour = Number(match[3]);
  const untilMinute = Number(match[4]);
  if (sinceHour > 23 || sinceMinute > 59 || untilHour > 23 || untilMinute > 59) {
    return null;
  }

  const since = new Date(now);
  since.setHours(sinceHour, sinceMinute, 0, 0);
  const until = new Date(now);
  until.setHours(untilHour, untilMinute, 0, 0);
  if (since >= until) return null;

  return {
    type: "absolute",
    range: { since: since.toISOString(), until: until.toISOString() },
  };
}

export function parseRangeInputForVisibleRange(
  input: string,
  visibleRange: ExploreRange,
  now: number,
): ParsedRangeInput | null {
  const visibleSince = new Date(visibleRange.since).getTime();
  return parseRangeInput(input, Number.isFinite(visibleSince) ? visibleSince : now);
}
