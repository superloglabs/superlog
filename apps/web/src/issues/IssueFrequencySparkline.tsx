export function IssueFrequencySparkline({
  buckets,
}: {
  buckets: { day: string; count: number }[];
}) {
  if (buckets.length === 0) return null;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const peakIndex = buckets.findIndex((bucket) => bucket.count === max);

  return (
    <div
      className="relative h-10 w-[112px]"
      role="img"
      aria-label={`Last ${buckets.length} days activity`}
    >
      <div className="absolute inset-x-0 bottom-0 flex h-6 items-end gap-[2px]">
        {buckets.map((bucket, index) => {
          const heightPercent = (bucket.count / max) * 100;
          const isPeak = index === peakIndex;
          return (
            <div
              key={bucket.day}
              title={`${bucket.day}: ${bucket.count.toLocaleString()} events`}
              className="relative flex-1 rounded-[1px]"
              style={{
                height: `max(1px, ${heightPercent}%)`,
                backgroundColor: "var(--color-accent)",
                opacity: bucket.count === 0 ? 0.18 : isPeak ? 1 : 0.5,
              }}
            >
              {isPeak && <PeakMarker value={bucket.count} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PeakMarker({ value }: { value: number }) {
  return (
    <span
      className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 whitespace-nowrap pb-0.5 font-sans text-[9px] leading-none tabular-nums"
      style={{ color: "var(--color-accent)" }}
      aria-hidden
    >
      {value.toLocaleString()}
    </span>
  );
}
