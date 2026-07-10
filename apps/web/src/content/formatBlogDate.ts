// Formats an ISO date (YYYY-MM-DD) as e.g. "Jul 10, 2026". Parsed as UTC to
// avoid a local-timezone off-by-one on the rendered day. Falls back to the raw
// string if it isn't a valid ISO date.

export function formatBlogDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
