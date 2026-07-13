import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

export type DropdownOption = {
  value: string;
  label: ReactNode;
  // Plain text used for the search filter and the collapsed trigger label.
  // Falls back to `value` when omitted.
  searchText?: string;
};

// Styled single-select dropdown matching the app's popover language (see
// RangePicker / RowMenu) — replaces the native <select> so the menu, search,
// and option rows are themed instead of the OS chrome. Searchable by default;
// pass `searchable={false}` for short lists.
export function Dropdown({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  searchable = true,
  emptyLabel = "No matches",
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: ReactNode;
  disabled?: boolean;
  searchable?: boolean;
  emptyLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => (o.searchText ?? o.value).toLowerCase().includes(q));
  }, [options, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: initialize selection only when the menu opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const idx = options.findIndex((o) => o.value === value);
    setHighlight(idx >= 0 ? idx : 0);
    setTimeout(() => {
      if (searchable) {
        inputRef.current?.focus();
      } else {
        listRef.current?.focus();
      }
    }, 0);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open, searchable]);

  // Keep the highlight in range as the filter narrows the list.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const apply = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    const lastIndex = Math.max(filtered.length - 1, 0);
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, lastIndex));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) apply(opt.value);
    }
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-left text-[13px] text-fg transition-colors hover:border-border-strong focus:border-border-strong focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className={`flex-1 truncate ${selected ? "text-fg" : "text-subtle"}`}>
          {selected ? (selected.searchText ?? selected.label) : placeholder}
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          ref={listRef}
          tabIndex={-1}
          onKeyDown={onKey}
          className="absolute left-0 top-full z-20 mt-1.5 w-full overflow-hidden rounded-lg border border-border bg-surface shadow-[0_16px_40px_-16px_rgba(0,0,0,0.7)]"
        >
          {searchable && (
            <div className="border-b border-border px-2.5">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                placeholder="Search…"
                className="h-9 w-full bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none"
              />
            </div>
          )}
          <div className="max-h-64 overflow-y-auto p-1 focus:outline-none">
            {filtered.length === 0 ? (
              <div className="px-2.5 py-2 text-[12px] text-subtle">{emptyLabel}</div>
            ) : (
              filtered.map((opt, i) => {
                const active = opt.value === value;
                const highlighted = i === highlight;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => apply(opt.value)}
                    onMouseEnter={() => setHighlight(i)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                      highlighted ? "bg-surface-2 text-fg" : active ? "text-fg" : "text-muted"
                    }`}
                  >
                    <span className="flex-1 truncate">{opt.label}</span>
                    {active && <CheckIcon />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg
      className="pointer-events-none h-3 w-3 shrink-0 text-subtle"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <title>Open dropdown</title>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 text-fg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <title>Selected</title>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
