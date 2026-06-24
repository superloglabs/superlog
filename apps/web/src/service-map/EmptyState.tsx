import type { ReactNode } from "react";
import { Btn } from "../design/ui.tsx";

// ---------------------------------------------------------------------------
// TopologyEmptyState
//
// Shown on the main page when a project has telemetry but no map has been built
// yet (OnboardingGate already blocks the truly-empty, pre-ingest case). A faint
// "ghost" topology sits behind the call-to-action so the canvas reads as a map
// the moment data lands, rather than a blank rectangle.
// ---------------------------------------------------------------------------

export function TopologyEmptyState({
  onConnectAws,
  onBuild,
  building = false,
  height = 680,
}: {
  /** Only passed when the project has NO cloud connection — otherwise omitted. */
  onConnectAws?: () => void;
  /** Request a build/rebuild of the map from the connected inventory + telemetry. */
  onBuild?: () => void;
  /** A build is in flight (worker is generating) — show progress, not the CTA. */
  building?: boolean;
  height?: number | string;
}) {
  return (
    <div
      className="relative w-full overflow-hidden rounded-2xl border border-border"
      style={{ height }}
    >
      {/* dotted canvas backdrop */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(var(--dot-color) 1.25px, transparent 1.25px)",
          backgroundSize: "22px 22px",
        }}
      />
      {/* ghost map */}
      <GhostMap />
      {/* fade + centered CTA */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 45%, color-mix(in srgb, var(--color-bg) 78%, transparent), color-mix(in srgb, var(--color-bg) 30%, transparent))",
        }}
      />
      <div className="absolute inset-0 grid place-items-center px-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-border-strong bg-surface text-muted">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              className="h-6 w-6"
            >
              <circle cx="5" cy="6" r="2.5" />
              <circle cx="19" cy="6" r="2.5" />
              <circle cx="12" cy="18" r="2.5" />
              <path d="M7 7.5 10.5 16M17 7.5 13.5 16M7.5 6h9" />
            </svg>
          </div>
          <h2 className="text-[20px] font-semibold tracking-tight text-fg">Map your system</h2>
          <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-muted">
            {onConnectAws
              ? "Connect your AWS account to map the infrastructure behind your services. An assistant proposes the groupings and links; you adjust anything."
              : "Build a live map from your connected cloud inventory and the telemetry you send. An assistant proposes the groupings and links; you adjust anything."}
          </p>
          <div className="mt-5 flex items-center justify-center gap-2.5">
            {onConnectAws ? (
              <Btn size="md" variant="primary" onClick={onConnectAws}>
                Connect AWS
              </Btn>
            ) : (
              <Btn size="md" variant="primary" onClick={onBuild} disabled={building}>
                {building ? "Building…" : "Generate map"}
              </Btn>
            )}
          </div>
          <p className="mt-3 text-[12px] text-subtle">
            {building
              ? "Building from your infrastructure & telemetry…"
              : "Takes a few seconds · you can edit or regenerate any time"}
          </p>
        </div>
      </div>
    </div>
  );
}

// A faint, non-interactive sample graph so the empty canvas still reads as a map.
function GhostMap() {
  const ghostNode = (x: number, y: number, w = 120): ReactNode => (
    <rect
      x={x}
      y={y}
      width={w}
      height={44}
      rx={12}
      fill="var(--color-surface-2)"
      stroke="var(--color-border)"
      strokeWidth={1}
    />
  );
  return (
    <svg
      className="absolute inset-0 h-full w-full opacity-50"
      viewBox="0 0 900 560"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* edges */}
      <g stroke="var(--color-subtle)" strokeWidth={1.25} strokeOpacity={0.5} fill="none">
        <path d="M170 130 L320 130 L320 110 L470 110" />
        <path d="M170 230 L320 230 L320 250 L470 250" />
        <path d="M590 110 L740 130" />
        <path d="M590 250 L740 250" />
        <path d="M530 170 L530 250" />
      </g>
      {/* nodes */}
      {ghostNode(60, 108)}
      {ghostNode(60, 208)}
      {ghostNode(470, 88)}
      {ghostNode(470, 228)}
      {ghostNode(740, 108)}
      {ghostNode(740, 228)}
    </svg>
  );
}
