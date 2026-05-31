import { useEffect, useMemo, useRef, useState } from "react";
import type { ExploreRange } from "../api.ts";
import { ShortcutKey } from "./ui.tsx";

export type RangeSelection = { seconds: number; label: string };

export const RANGE_PRESETS: RangeSelection[] = [
  { seconds: 15 * 60, label: "Last 15 minutes" },
  { seconds: 60 * 60, label: "Last 1h" },
  { seconds: 6 * 60 * 60, label: "Last 6h" },
  { seconds: 24 * 60 * 60, label: "Last 24h" },
  { seconds: 7 * 24 * 60 * 60, label: "Last 7d" },
];

export function rangeFromSeconds(seconds: number, now: number): ExploreRange {
  return {
    since: new Date(now - seconds * 1000).toISOString(),
    until: new Date(now).toISOString(),
  };
}

const UNIT_SECS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
};

export function formatSeconds(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function fmtTime(d: Date): string {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatRangeLabel(range: ExploreRange, durationLabel: string): string {
  const since = new Date(range.since);
  const until = new Date(range.until);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    return durationLabel;
  }
  const sameDay = since.toDateString() === until.toDateString();
  const left = sameDay ? fmtTime(since) : fmtDate(since);
  const right = sameDay ? fmtTime(until) : fmtDate(until);
  return `${left} → ${right} (${durationLabel})`;
}

function formatSecondsVerbose(seconds: number): string {
  const units: Array<[number, string]> = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `Last ${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `Last ${seconds} seconds`;
}

export function parseDurationInput(input: string): RangeSelection | null {
  const cleaned = input.trim().toLowerCase().replace(/^(last|past)\s+/, "");
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
  if (!match) return null;
  const n = Number.parseFloat(match[1]!);
  const mult = UNIT_SECS[match[2]!];
  if (!mult || !Number.isFinite(n) || n <= 0) return null;
  return { seconds: n * mult, label: `Last ${input.trim()}` };
}

export function RangePicker({
  value,
  range,
  onChange,
}: {
  value: RangeSelection;
  range: ExploreRange;
  onChange: (v: RangeSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // `t` opens the range picker from anywhere on the page — same gesture
  // pattern as `/` (metric search), `f` (filter), `a` (aggregation),
  // `g` (group by). Ignored while a form field is already focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "t" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          (t as HTMLElement).isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setDraft(value.label);
    // Highlight the row matching the current selection so ↓↑ starts from a
    // meaningful place, not always row 0.
    const idx = RANGE_PRESETS.findIndex((p) => p.label === value.label);
    setHighlight(idx >= 0 ? idx : 0);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, value.label]);

  const parsed = useMemo(() => parseDurationInput(draft), [draft]);
  const draftIsCurrent = draft.trim().toLowerCase() === value.label.trim().toLowerCase();

  const apply = (next: RangeSelection) => {
    onChange(next);
    setOpen(false);
  };

  const submitDraft = () => {
    if (parsed) apply(parsed);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, RANGE_PRESETS.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Prefer the parsed expression when the user typed something
      // different from the current selection; otherwise fall back to the
      // keyboard-highlighted preset row.
      if (parsed && !draftIsCurrent) {
        apply(parsed);
      } else {
        const preset = RANGE_PRESETS[highlight];
        if (preset) apply(preset);
      }
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface pl-3 pr-1.5 text-[13px] text-fg transition-colors hover:border-border-strong"
      >
        <span className="whitespace-nowrap">{formatRangeLabel(range, value.label)}</span>
        <ShortcutKey>T</ShortcutKey>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-2xl">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <ClockIcon />
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="Type a range — e.g. last 30 minutes"
              className="h-10 flex-1 bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none"
            />
            {draft.trim() && !draftIsCurrent && (
              <span
                className={`shrink-0 whitespace-nowrap font-mono text-[11px] ${
                  parsed ? "text-success" : "text-subtle"
                }`}
              >
                {parsed ? `= ${formatSecondsVerbose(parsed.seconds)}` : "?"}
              </span>
            )}
          </div>
          <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.18em] text-subtle">
            Quick ranges
          </div>
          <div className="flex flex-col gap-0.5 p-1.5">
            {RANGE_PRESETS.map((p, i) => {
              const active = p.label === value.label;
              const highlighted = i === highlight;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => apply(p)}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors ${
                    highlighted ? "bg-surface-2 text-fg" : active ? "text-fg" : "text-muted"
                  }`}
                >
                  <ClockIcon />
                  <span className="flex-1">{p.label}</span>
                  <span className="font-mono text-[11px] text-subtle">
                    {formatSeconds(p.seconds)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ClockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-subtle"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

