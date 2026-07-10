import React from "react";

export type FacetValue = {
  value: string;
  label: string;
  count?: number;
};

export function facetDisplayName(value: string): string {
  const words = value
    .replace(/^(resource|span|log)\./, "")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : value;
}

export function FacetValues({
  facetLabel,
  values,
  selectedValues,
  onToggle,
}: {
  facetLabel: string;
  values: FacetValue[];
  selectedValues: ReadonlySet<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="space-y-0.5 px-2 pb-2">
      {values.map((item) => {
        const selected = selectedValues.has(item.value);
        return (
          <label
            key={item.value}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11.5px] transition-colors ${
              selected ? "bg-accent/10 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            <input
              type="checkbox"
              aria-label={`${facetLabel}: ${item.label}`}
              checked={selected}
              onChange={() => onToggle(item.value)}
              className="sr-only"
            />
            <span
              aria-hidden
              className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border ${
                selected ? "border-accent bg-accent text-accent-ink" : "border-border-strong"
              }`}
            >
              {selected ? "✓" : null}
            </span>
            <span className="min-w-0 flex-1 truncate font-sans" title={item.label}>
              {item.label}
            </span>
            {item.count !== undefined ? (
              <span className="shrink-0 font-sans text-[10px] tabular-nums text-subtle">
                {item.count.toLocaleString()}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}
