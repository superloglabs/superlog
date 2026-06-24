import { applyEnrichment, groupPath, viewTopology } from "@superlog/topology";
import type { Density } from "@superlog/topology";
import { type ReactNode, useMemo, useState } from "react";
import { TopologyEmptyState } from "../../service-map/EmptyState.tsx";
import { EdgeLegend, TopologyCanvas } from "../../service-map/TopologyCanvas.tsx";
import { sampleEnrichment } from "./enrichment.fixtures.ts";
import { rawTopology } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// Service Map — /design/service-map
//
// Two-level map of Superlog's OWN prod infra. The LLM groups resources into a
// few logical *services by intent* (Web app · API & backend · Telemetry pipeline
// · External integrations) — that's the top level. Click a service to explode it
// into the resources it's made of, with faded stubs to the services it talks to.
// Data is real (./fixtures.ts); the grouping is the baked AI pass
// (./enrichment.fixtures.ts).
// ---------------------------------------------------------------------------

type View = "map" | "empty";

export function ServiceMapPlayground() {
  const [view, setView] = useState<View>("map");
  // Deep-linkable: /design/service-map?service=backend opens that service directly.
  const [focused, setFocused] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("service"),
  );
  const [density, setDensity] = useState<Density>("comfortable");
  const [showDots, setShowDots] = useState(true);

  // Services require the AI grouping pass, so we always enrich the raw graph.
  const enriched = useMemo(() => applyEnrichment(rawTopology, sampleEnrichment), []);
  const focusedGroup = focused ? enriched.groups.find((g) => g.id === focused) : undefined;
  const topology = useMemo(() => viewTopology(enriched, focused), [enriched, focused]);
  const path = useMemo(() => groupPath(enriched, focused), [enriched, focused]);

  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <SubpageNav crumb="Service map" />
      <main className="mx-auto max-w-7xl px-6 pb-24 pt-8">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-[13px] font-medium text-muted">Storybook · real data</span>
            <h1 className="mt-1.5 text-[30px] font-semibold tracking-tight text-fg">Service map</h1>
            <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-muted">
              An LLM groups our infrastructure into a few logical services by intent. Click a
              service to explode it into the resources it's built from.
            </p>
          </div>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "map", label: "Map" },
              { value: "empty", label: "Empty state" },
            ]}
          />
        </header>

        {view === "empty" ? (
          <TopologyEmptyState />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <Breadcrumb path={path} onNavigate={setFocused} />
              <div className="flex items-center gap-2">
                <Segmented
                  value={density}
                  onChange={setDensity}
                  options={[
                    { value: "comfortable", label: "Comfortable" },
                    { value: "compact", label: "Compact" },
                  ]}
                />
                <Toggle on={showDots} onClick={() => setShowDots((v) => !v)} label="Dots" />
              </div>
            </div>

            {focused ? (
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-[13px] text-muted">
                  {focusedGroup?.intent}
                  <span className="text-subtle">
                    {" "}
                    · dashed cards are neighbouring services — click to hop
                  </span>
                </p>
                <EdgeLegend />
              </div>
            ) : (
              sampleEnrichment.summary && (
                <div className="mb-3 flex items-start gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-2.5">
                  <span className="mt-0.5 text-accent">
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
                      <path d="M12 2l1.6 4.8L18 8l-4.4 1.2L12 14l-1.6-4.8L6 8l4.4-1.2L12 2z" />
                    </svg>
                  </span>
                  <span className="text-[12.5px] leading-relaxed text-muted">
                    {sampleEnrichment.summary}
                  </span>
                </div>
              )
            )}

            <TopologyCanvas
              key={focused ?? "overview"}
              topology={topology}
              density={density}
              showGroups={false}
              showDots={showDots}
              fitHeight
              fitWidth
              lockNodes
              onNodeOpen={(serviceId) => setFocused(serviceId)}
            />
          </>
        )}
      </main>
    </div>
  );
}

// ---- small controls --------------------------------------------------------

function Breadcrumb({
  path,
  onNavigate,
}: { path: { id: string; label: string }[]; onNavigate: (id: string | null) => void }) {
  return (
    <div className="flex items-center gap-2 text-[14px]">
      <button
        type="button"
        onClick={() => onNavigate(null)}
        className={`font-medium transition-colors ${path.length === 0 ? "text-fg" : "text-muted hover:text-fg"}`}
      >
        All services
      </button>
      {path.map((seg, i) => {
        const last = i === path.length - 1;
        return (
          <span key={seg.id} className="flex items-center gap-2">
            <span className="text-subtle">/</span>
            <button
              type="button"
              onClick={() => onNavigate(seg.id)}
              disabled={last}
              className={`font-medium transition-colors ${last ? "text-fg" : "text-muted hover:text-fg"}`}
            >
              {seg.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${value === o.value ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${on ? "border-border-strong text-fg" : "border-border text-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );
}

function SubpageNav({ crumb }: { crumb: string }): ReactNode {
  return (
    <header className="relative z-10">
      <div className="px-6">
        <nav className="flex items-center justify-start gap-3 py-5">
          <a
            href="/design"
            className="text-[14px] font-medium text-muted transition-opacity hover:text-fg"
          >
            ← Design
          </a>
          <span className="text-[14px] text-subtle">/</span>
          <span className="text-[14px] font-medium text-fg">{crumb}</span>
        </nav>
      </div>
      <div style={{ height: "0.5px", background: "rgba(255,255,255,0.07)" }} />
    </header>
  );
}
