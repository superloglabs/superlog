import {
  type Topology,
  type TopologyEnrichment,
  applyEnrichment,
  groupPath,
  viewTopology,
} from "@superlog/topology";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type TopologyDoc, useGenerateTopology, useTopology } from "../api.ts";
import { TopologyEmptyState } from "./EmptyState.tsx";
import { EdgeLegend, TopologyCanvas } from "./TopologyCanvas.tsx";

// Production service map on the Overview page. Reads the persisted topology, applies
// the LLM grouping, and shows the two-level drill (services → resources). The build
// itself runs in the worker; here we just render + request (re)builds.
export function ServiceMap({ projectId }: { projectId: string }) {
  const { data, isLoading } = useTopology(projectId);
  const generate = useGenerateTopology(projectId);
  const navigate = useNavigate();
  const [focused, setFocused] = useState<string | null>(null);

  const graph = data?.graph ?? null;
  const enrichment = (data?.enrichment ?? null) as TopologyEnrichment | null;

  // Apply the AI grouping (if any), then collapse to services. Degrades to the flat
  // resource graph when the enrichment pass hasn't run.
  const enriched = useMemo<Topology | null>(
    () => (graph ? (enrichment ? applyEnrichment(graph, enrichment) : graph) : null),
    [graph, enrichment],
  );
  const hasServices = (enriched?.groups.length ?? 0) > 0;
  const focusedGroup =
    focused && enriched ? enriched.groups.find((g) => g.id === focused) : undefined;
  // One call renders any level of the hierarchy (root, a parent service, a leaf).
  const shown = useMemo(
    () => (enriched ? viewTopology(enriched, focused) : null),
    [enriched, focused],
  );
  const path = useMemo(() => (enriched ? groupPath(enriched, focused) : []), [enriched, focused]);

  const empty = !graph || enriched?.nodes.length === 0;

  return (
    <section>
      <Header
        generatedAt={data?.generatedAt ?? null}
        status={data?.status}
        generating={generate.isPending || data?.status === "generating"}
        onRegenerate={() => generate.mutate()}
        showRegenerate={!empty}
      />

      {isLoading ? (
        <Skeleton />
      ) : empty ? (
        <TopologyEmptyState
          height={420}
          onBuildFromTelemetry={() => generate.mutate()}
          onConnectAws={() => navigate("/settings?scope=project&section=integrations")}
        />
      ) : (
        <>
          {hasServices && (
            <MapNav
              path={path}
              intent={focusedGroup?.intent}
              showLegend={!!focused}
              onNavigate={setFocused}
            />
          )}
          {shown && (
            <TopologyCanvas
              key={focused ?? "overview"}
              topology={shown}
              showGroups={false}
              showDots
              fitHeight
              fitWidth
              lockNodes
              onNodeOpen={(serviceId) => setFocused(serviceId)}
              frame={
                focused && focusedGroup
                  ? {
                      label: focusedGroup.label,
                      tone: focusedGroup.tone,
                      aiProposed: focusedGroup.aiProposed,
                    }
                  : undefined
              }
            />
          )}
        </>
      )}
    </section>
  );
}

function Header({
  generatedAt,
  status,
  generating,
  onRegenerate,
  showRegenerate,
}: {
  generatedAt: string | null;
  status?: TopologyDoc["status"];
  generating: boolean;
  onRegenerate: () => void;
  showRegenerate: boolean;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-[18px] font-semibold tracking-tight text-fg">Service map</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          {generating
            ? "Building from your infrastructure & telemetry…"
            : status === "error"
              ? "Last build failed — try again."
              : generatedAt
                ? `Updated ${timeAgo(generatedAt)}`
                : "Your services, grouped by what they do."}
        </p>
      </div>
      {showRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={generating}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:text-fg disabled:opacity-50"
        >
          {generating ? "Building…" : "Regenerate"}
        </button>
      )}
    </div>
  );
}

// Navigation layer above the map: back control + breadcrumb path + the current
// level's intent, with the edge legend on the right.
function MapNav({
  path,
  intent,
  showLegend,
  onNavigate,
}: {
  path: { id: string; label: string }[];
  intent?: string;
  showLegend: boolean;
  onNavigate: (id: string | null) => void;
}) {
  const parent = path.length >= 2 ? path[path.length - 2]!.id : null;
  const canGoBack = path.length > 0;
  return (
    <div className="mb-3 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate(parent)}
            disabled={!canGoBack}
            aria-label="Back"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border text-muted transition-colors enabled:hover:text-fg disabled:opacity-40"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
            >
              <path d="m15 6-6 6 6 6" />
            </svg>
          </button>
          <nav className="flex min-w-0 items-center gap-2 text-[13.5px]">
            <button
              type="button"
              onClick={() => onNavigate(null)}
              className={`font-medium transition-colors ${path.length === 0 ? "text-fg" : "text-muted hover:text-fg"}`}
            >
              All groups
            </button>
            {path.map((seg, i) => {
              const last = i === path.length - 1;
              return (
                <span key={seg.id} className="flex min-w-0 items-center gap-2">
                  <span className="text-subtle">/</span>
                  <button
                    type="button"
                    onClick={() => onNavigate(seg.id)}
                    disabled={last}
                    className={`truncate font-medium transition-colors ${last ? "text-fg" : "text-muted hover:text-fg"}`}
                  >
                    {seg.label}
                  </button>
                </span>
              );
            })}
          </nav>
        </div>
        {showLegend && <EdgeLegend />}
      </div>
      {intent && <p className="mt-1.5 pl-[34px] text-[12.5px] text-muted">{intent}</p>}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="h-[420px] w-full animate-pulse rounded-2xl border border-border bg-surface-2" />
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
