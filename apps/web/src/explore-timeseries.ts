import type { ExploreRange } from "./api.ts";
import { formatLocalHm, formatLocalTimestamp } from "./timeFormat.ts";

export function parseStepMs(step: string | undefined): number | undefined {
  if (!step) return undefined;
  const match = step.match(/^(\d+)\s+(SECOND|MINUTE|HOUR|DAY)/i);
  if (!match) return undefined;
  const [, amountInput, unitInput] = match;
  if (!amountInput || !unitInput) return undefined;
  const amount = Number.parseInt(amountInput, 10);
  const unit = unitInput.toUpperCase();
  const multiplier =
    unit === "SECOND"
      ? 1000
      : unit === "MINUTE"
        ? 60_000
        : unit === "HOUR"
          ? 3_600_000
          : 86_400_000;
  return amount * multiplier;
}

function bucketTime(bucket: string): number {
  return new Date(`${bucket.replace(" ", "T")}Z`).getTime();
}

export function rangeFromBucketSelection(
  firstBucket: string,
  lastBucket: string,
  step: string | undefined,
  currentRange: ExploreRange,
): ExploreRange | null {
  const stepMs = parseStepMs(step);
  const first = bucketTime(firstBucket);
  const last = bucketTime(lastBucket);
  const currentSince = new Date(currentRange.since).getTime();
  const currentUntil = new Date(currentRange.until).getTime();
  if (
    !stepMs ||
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    !Number.isFinite(currentSince) ||
    !Number.isFinite(currentUntil)
  ) {
    return null;
  }

  const since = Math.max(Math.min(first, last), currentSince);
  const until = Math.min(Math.max(first, last) + stepMs, currentUntil);
  if (since >= until) return null;
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
  };
}

export function bucketSeriesSpansDates(buckets: string[]): boolean {
  return new Set(buckets.map((bucket) => formatLocalTimestamp(bucket).slice(0, 10))).size > 1;
}

export function formatBucketAxisTick(bucket: string, includeDate: boolean): string {
  return includeDate ? formatLocalTimestamp(bucket).slice(5, 16) : formatLocalHm(bucket);
}
