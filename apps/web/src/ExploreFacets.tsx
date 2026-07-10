import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { type FacetValue, FacetValues, facetDisplayName } from "./FacetValues.tsx";
import {
  type AttributeKey,
  type ExploreRange,
  type ResourceAttr,
  useExploreAttributeKeys,
  useExploreAttributeValues,
} from "./api.ts";
import { toggleAttrFilter, toggleSingleFacetValue } from "./exploreAttrFilter.ts";

export const SEVERITY_OPTIONS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "STATUS_CODE_OK", label: "Ok" },
  { value: "STATUS_CODE_ERROR", label: "Error" },
  { value: "STATUS_CODE_UNSET", label: "Unset" },
];

type FacetSource = "logs" | "traces";

export function ExploreFacets({
  projectId,
  range,
  source,
  attrs,
  onAttrsChange,
  severity = "",
  onSeverityChange,
  statusCode = "",
  onStatusCodeChange,
}: {
  projectId: string;
  range: ExploreRange;
  source: FacetSource;
  attrs: ResourceAttr[];
  onAttrsChange: (attrs: ResourceAttr[]) => void;
  severity?: string;
  onSeverityChange: (value: string) => void;
  statusCode?: string;
  onStatusCodeChange: (value: string) => void;
}) {
  const primaryFacet = source === "logs" ? "severity" : "status";
  const [expandedFacet, setExpandedFacet] = useState(primaryFacet);
  const [query, setQuery] = useState("");
  const keys = useExploreAttributeKeys(projectId, range, source);
  const activeAttributeKey = expandedFacet.startsWith("attr:")
    ? expandedFacet.slice("attr:".length)
    : undefined;
  const values = useExploreAttributeValues(projectId, activeAttributeKey, range, source);

  useEffect(() => {
    setExpandedFacet(primaryFacet);
    setQuery("");
  }, [primaryFacet]);

  const visibleKeys = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return keys.data ?? [];
    return (keys.data ?? []).filter((key) => key.key.toLowerCase().includes(normalized));
  }, [keys.data, query]);

  const selectedAttributeValues = useMemo(() => {
    if (!activeAttributeKey) return new Set<string>();
    return new Set(
      attrs
        .filter((attr) => attr.key === activeAttributeKey && (attr.op ?? "eq") === "eq")
        .map((attr) => attr.value),
    );
  }, [activeAttributeKey, attrs]);

  const attributeValues = useMemo(() => {
    const rows: FacetValue[] = (values.data ?? []).map((value) => ({
      value: value.value,
      label: value.value,
      count: value.count,
    }));
    const loaded = new Set(rows.map((row) => row.value));
    for (const selected of selectedAttributeValues) {
      if (!loaded.has(selected)) rows.unshift({ value: selected, label: selected });
    }
    return rows;
  }, [selectedAttributeValues, values.data]);

  const toggleExpanded = (facet: string) => {
    setExpandedFacet((current) => (current === facet ? "" : facet));
  };

  return (
    <aside
      aria-label="Explore facets"
      className="overflow-hidden rounded-lg border border-border bg-surface xl:sticky xl:top-4"
    >
      <div className="border-b border-border px-3 pb-3 pt-3.5">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <h2 className="text-[12px] font-medium text-fg">Facets</h2>
          <span className="font-sans text-[10px] text-subtle">{keys.data?.length ?? 0} Fields</span>
        </div>
        <div className="relative">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-subtle"
          >
            <title>Search facets</title>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            aria-label="Search facets"
            placeholder="Find a facet…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-7 w-full rounded-sm border border-border bg-surface-2 pl-7 pr-2 text-[11.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
        </div>
      </div>

      <div className="max-h-[min(68vh,720px)] overflow-y-auto py-1.5">
        {!query && source === "logs" ? (
          <FacetGroup
            id="severity"
            label="Severity"
            expanded={expandedFacet === "severity"}
            selectedCount={severity ? 1 : 0}
            onToggle={() => toggleExpanded("severity")}
          >
            <FacetValues
              facetLabel="Severity"
              values={SEVERITY_OPTIONS.map((value) => ({
                value,
                label: facetDisplayName(value),
              }))}
              selectedValues={new Set(severity ? [severity] : [])}
              onToggle={(value) => onSeverityChange(toggleSingleFacetValue(severity, value))}
            />
          </FacetGroup>
        ) : null}

        {!query && source === "traces" ? (
          <FacetGroup
            id="status"
            label="Status"
            expanded={expandedFacet === "status"}
            selectedCount={statusCode ? 1 : 0}
            onToggle={() => toggleExpanded("status")}
          >
            <FacetValues
              facetLabel="Status"
              values={STATUS_OPTIONS}
              selectedValues={new Set(statusCode ? [statusCode] : [])}
              onToggle={(value) => onStatusCodeChange(toggleSingleFacetValue(statusCode, value))}
            />
          </FacetGroup>
        ) : null}

        {keys.isLoading ? (
          <div className="px-4 py-5 font-sans text-[11px] text-subtle">Loading facets…</div>
        ) : visibleKeys.length === 0 ? (
          <div className="px-4 py-5 text-[11px] text-subtle">
            {query ? "No matching facets." : "No attributes in this window."}
          </div>
        ) : (
          visibleKeys.map((key) => {
            const facetId = `attr:${key.key}`;
            const selectedCount = selectedCountFor(attrs, key.key);
            return (
              <FacetGroup
                key={key.key}
                id={facetId}
                label={facetDisplayName(key.key)}
                count={key.count}
                selectedCount={selectedCount}
                expanded={expandedFacet === facetId}
                onToggle={() => toggleExpanded(facetId)}
              >
                {values.isLoading ? (
                  <div className="px-4 pb-3 pt-1 font-sans text-[11px] text-subtle">
                    Loading values…
                  </div>
                ) : attributeValues.length === 0 ? (
                  <div className="px-4 pb-3 pt-1 text-[11px] text-subtle">
                    No values in this window.
                  </div>
                ) : (
                  <FacetValues
                    facetLabel={facetDisplayName(key.key)}
                    values={attributeValues}
                    selectedValues={selectedAttributeValues}
                    onToggle={(value) => onAttrsChange(toggleAttrFilter(attrs, key.key, value))}
                  />
                )}
              </FacetGroup>
            );
          })
        )}
      </div>
    </aside>
  );
}

function selectedCountFor(attrs: ResourceAttr[], key: string): number {
  return attrs.filter((attr) => attr.key === key && (attr.op ?? "eq") === "eq").length;
}

function FacetGroup({
  id,
  label,
  count,
  selectedCount,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  count?: AttributeKey["count"];
  selectedCount: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const panelId = `facet-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <section className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-2"
      >
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className={`h-3 w-3 shrink-0 text-subtle transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        >
          <title>{expanded ? `Collapse ${label}` : `Expand ${label}`}</title>
          <path d="m7 4 6 6-6 6" />
        </svg>
        <span className="min-w-0 flex-1 truncate font-sans text-[11.5px] text-fg" title={label}>
          {label}
        </span>
        {selectedCount > 0 ? (
          <span className="grid min-w-4 place-items-center rounded-full bg-accent px-1 py-0.5 font-sans text-[9px] leading-none text-accent-ink">
            {selectedCount}
          </span>
        ) : count !== undefined ? (
          <span className="font-sans text-[9px] tabular-nums text-subtle">
            {count.toLocaleString()}
          </span>
        ) : null}
      </button>
      {expanded ? <div id={panelId}>{children}</div> : null}
    </section>
  );
}
