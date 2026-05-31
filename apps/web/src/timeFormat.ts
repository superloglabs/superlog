// Helpers for displaying ClickHouse-stored timestamps (UTC) in the user's local
// timezone. ClickHouse returns DateTime / DateTime64 as
// "YYYY-MM-DD HH:MM:SS[.fraction]" — a naive string with no zone. The server is
// UTC, so we parse as UTC and reformat in local time.

function parseChUtc(s: string): { date: Date; frac: string } | null {
  if (!s) return null;
  const dot = s.indexOf(".");
  const head = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  // Accept both "YYYY-MM-DD HH:MM:SS" and ISO "YYYY-MM-DDTHH:MM:SS".
  const iso = head.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { date: d, frac };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// "YYYY-MM-DD HH:MM:SS.ff" in local tz, fraction rounded to 2 digits.
export function formatLocalTimestampMs(s: string): string {
  const p = parseChUtc(s);
  if (!p) return s;
  const { date, frac } = p;
  const head =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  const fracN = Number(`0.${frac || "0"}`);
  const f = Number.isFinite(fracN)
    ? Math.round(fracN * 100).toString().padStart(2, "0")
    : "00";
  return `${head}.${f}`;
}

// "YYYY-MM-DD HH:MM:SS" in local tz (no fractional seconds).
export function formatLocalTimestamp(s: string): string {
  const p = parseChUtc(s);
  if (!p) return s;
  const { date } = p;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

// "HH:MM" in local tz — for chart axis ticks.
export function formatLocalHm(s: string): string {
  const p = parseChUtc(s);
  if (!p) return s.length >= 16 ? s.slice(11, 16) : s;
  const { date } = p;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

let cachedTzAbbr: string | null = null;
export function localTzAbbr(): string {
  if (cachedTzAbbr) return cachedTzAbbr;
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
    }).formatToParts(new Date());
    const tz = parts.find((p) => p.type === "timeZoneName")?.value;
    cachedTzAbbr = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    cachedTzAbbr = "local";
  }
  return cachedTzAbbr!;
}
