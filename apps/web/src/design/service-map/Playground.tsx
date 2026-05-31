import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Btn } from "../ui.tsx";

// ---------------------------------------------------------------------------
// Service Map — /design/service-map
//
// A react-flow-flavored canvas for laying out services. Dotted background,
// draggable nodes, curved edges, services bucketed into groups, and up to
// three signal badges per service (cost · security · performance).
//
// Aesthetic: soft rounded cards with a double-outline halo, sans-serif
// normal-case type, a hairline header divider, and dashed leader rows that
// pair a label with a solid / soft pill (echoing the Cloudflare node card).
// Storybook only — all data is mocked below.
// ---------------------------------------------------------------------------

const NODE_W = 248;
const HEADER_H = 54; // icon + name row, down to the hairline divider
const BADGE_ROW_H = 42; // compact badge row

type BadgeKind = "cost" | "security" | "performance";

type Badge = { kind: BadgeKind; count: number };

type ServiceStatus = "healthy" | "degraded" | "down";

type ServiceNode = {
  id: string;
  name: string;
  kind: string;
  status: ServiceStatus;
  group: string;
  x: number;
  y: number;
  badges: Badge[];
};

type Group = {
  id: string;
  name: string;
  tone: "accent" | "success" | "warning" | "neutral";
};

type Edge = { from: string; to: string };

// ---------------------------------------------------------------------------
// Mock topology
// ---------------------------------------------------------------------------

const GROUPS: Group[] = [
  { id: "edge", name: "Edge", tone: "accent" },
  { id: "core", name: "Core services", tone: "neutral" },
  { id: "data", name: "Data plane", tone: "success" },
];

const INITIAL_NODES: ServiceNode[] = [
  {
    id: "proxy",
    name: "intake-proxy",
    kind: "edge",
    status: "healthy",
    group: "edge",
    x: 40,
    y: 130,
    badges: [{ kind: "performance", count: 1 }],
  },
  {
    id: "web",
    name: "web",
    kind: "static",
    status: "healthy",
    group: "edge",
    x: 40,
    y: 300,
    badges: [],
  },
  {
    id: "api",
    name: "checkout-api",
    kind: "service",
    status: "degraded",
    group: "core",
    x: 392,
    y: 96,
    badges: [
      { kind: "security", count: 2 },
      { kind: "performance", count: 3 },
    ],
  },
  {
    id: "worker",
    name: "payments-worker",
    kind: "worker",
    status: "down",
    group: "core",
    x: 392,
    y: 300,
    badges: [
      { kind: "cost", count: 1 },
      { kind: "security", count: 1 },
      { kind: "performance", count: 2 },
    ],
  },
  {
    id: "auth",
    name: "auth",
    kind: "service",
    status: "healthy",
    group: "core",
    x: 392,
    y: 480,
    badges: [{ kind: "security", count: 1 }],
  },
  {
    id: "pg",
    name: "postgres",
    kind: "database",
    status: "healthy",
    group: "data",
    x: 760,
    y: 150,
    badges: [{ kind: "cost", count: 2 }],
  },
  {
    id: "clickhouse",
    name: "clickhouse",
    kind: "database",
    status: "degraded",
    group: "data",
    x: 760,
    y: 332,
    badges: [
      { kind: "cost", count: 1 },
      { kind: "performance", count: 1 },
    ],
  },
];

const EDGES: Edge[] = [
  { from: "proxy", to: "api" },
  { from: "web", to: "api" },
  { from: "worker", to: "auth" },
  { from: "api", to: "worker" },
  { from: "api", to: "pg" },
  { from: "worker", to: "clickhouse" },
  { from: "worker", to: "pg" },
];

// ---------------------------------------------------------------------------
// Badge metadata
// ---------------------------------------------------------------------------

const BADGE_META: Record<
  BadgeKind,
  {
    label: string;
    color: string;
    ink: string; // readable text color when used as a solid fill
    icon: ReactNode;
    blurb: (n: number) => string;
  }
> = {
  cost: {
    label: "Cost anomalies",
    color: "var(--color-warning)",
    ink: "#1a1505",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    ),
    blurb: (n) => `Spend spiked vs. the 7-day baseline in ${n} ${n === 1 ? "area" : "areas"}.`,
  },
  security: {
    label: "Security issues",
    color: "var(--color-danger)",
    ink: "#fff",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    blurb: (n) => `${n} exposed ${n === 1 ? "surface" : "surfaces"} or unpatched dependency flagged.`,
  },
  performance: {
    label: "Performance",
    color: "var(--color-accent)",
    ink: "#fff",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
    blurb: (n) => `${n} ${n === 1 ? "endpoint" : "endpoints"} above the latency SLO.`,
  },
};

const BADGE_ORDER: BadgeKind[] = ["cost", "security", "performance"];

const STATUS_COLOR: Record<ServiceStatus, string> = {
  healthy: "var(--color-success)",
  degraded: "var(--color-warning)",
  down: "var(--color-danger)",
};

const STATUS_LABEL: Record<ServiceStatus, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
};

const GROUP_TONE: Record<Group["tone"], { border: string; bg: string; label: string }> = {
  accent: { border: "rgba(72,90,226,0.32)", bg: "rgba(72,90,226,0.05)", label: "var(--color-accent)" },
  success: { border: "rgba(65,209,149,0.28)", bg: "rgba(65,209,149,0.045)", label: "var(--color-success)" },
  warning: { border: "rgba(231,177,90,0.28)", bg: "rgba(231,177,90,0.045)", label: "var(--color-warning)" },
  neutral: { border: "rgba(255,255,255,0.12)", bg: "rgba(255,255,255,0.02)", label: "var(--color-muted)" },
};

const KIND_ICON: Record<string, ReactNode> = {
  edge: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </svg>
  ),
  service: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
    </svg>
  ),
  worker: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v3M12 19v3M5 12H2M22 12h-3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  ),
  database: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  ),
  static: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18" />
    </svg>
  ),
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Edges anchor at the header row so expanding a node doesn't shift its ports.
const PORT_Y = 27;

function nodeHeight(node: ServiceNode): number {
  return HEADER_H + (node.badges.length === 0 ? 36 : BADGE_ROW_H);
}

// Gap so the line + arrowhead clear each card's outer halo ring (~5px) rather
// than being painted over by it.
const PORT_GAP = 9;
// Minimum horizontal separation before we route side-to-side; below it the
// nodes are effectively stacked and we route top/bottom instead.
const LR_THRESHOLD = 24;

// Orthogonal "step" connector with sharp right-angle corners. Picks exit/entry
// sides from geometry so the arrowhead always points *into* the target card
// rather than back out of it.
function edgePath(a: ServiceNode, b: ServiceNode, ha: number, hb: number): string {
  const G = PORT_GAP;
  const aRight = a.x + NODE_W;

  if (b.x >= aRight + LR_THRESHOLD) {
    // Left → right: exit a's right edge, enter b's left edge.
    const sx = aRight + G;
    const sy = a.y + PORT_Y;
    const tx = b.x - G;
    const ty = b.y + PORT_Y;
    const midX = sx + (tx - sx) / 2;
    return `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ty} L ${tx} ${ty}`;
  }

  // Stacked: route vertically between the facing edges.
  const sx = a.x + NODE_W / 2;
  const tx = b.x + NODE_W / 2;
  if (b.y >= a.y) {
    // b below a: exit a's bottom, enter b's top.
    const sy = a.y + ha + G;
    const ty = b.y - G;
    const midY = sy + (ty - sy) / 2;
    return `M ${sx} ${sy} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${ty}`;
  }
  // b above a: exit a's top, enter b's bottom.
  const sy = a.y - G;
  const ty = b.y + hb + G;
  const midY = sy + (ty - sy) / 2;
  return `M ${sx} ${sy} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${ty}`;
}

function groupBounds(nodes: ServiceNode[]) {
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs.map((x) => x + NODE_W));
  const maxY = Math.max(...nodes.map((n) => n.y + nodeHeight(n)));
  const padX = 22;
  const padTop = 60; // room for the group label tab plus a gap above the first card
  const padBottom = 22;
  return {
    x: minX - padX,
    y: minY - padTop,
    w: maxX - minX + padX * 2,
    h: maxY - minY + padTop + padBottom,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ServiceMapPlayground() {
  const [nodes, setNodes] = useState<ServiceNode[]>(INITIAL_NODES);
  const [selectedId, setSelectedId] = useState<string | null>("api");
  const [showGroups, setShowGroups] = useState(true);
  const [showDots, setShowDots] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { mode: "node"; id: string; startX: number; startY: number; originX: number; originY: number; moved: boolean }
    | { mode: "pan"; startX: number; startY: number; originX: number; originY: number; moved: boolean }
    | null
  >(null);

  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);
  const selected = selectedId ? byId[selectedId] ?? null : null;

  // Drag on a node moves the node.
  const onNodePointerDown = useCallback((e: React.PointerEvent, node: ServiceNode) => {
    e.preventDefault();
    e.stopPropagation();
    viewport.current?.setPointerCapture?.(e.pointerId);
    drag.current = {
      mode: "node",
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      originX: node.x,
      originY: node.y,
      moved: false,
    };
  }, []);

  // Drag on the empty canvas pans the whole map.
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      viewport.current?.setPointerCapture?.(e.pointerId);
      setPanning(true);
      drag.current = { mode: "pan", startX: e.clientX, startY: e.clientY, originX: pan.x, originY: pan.y, moved: false };
    },
    [pan.x, pan.y],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "pan") {
      if (Math.abs(dx) + Math.abs(dy) >= 3) d.moved = true;
      setPan({ x: d.originX + dx, y: d.originY + dy });
      return;
    }
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    const nx = Math.max(0, d.originX + dx);
    const ny = Math.max(0, d.originY + dy);
    setNodes((prev) => prev.map((n) => (n.id === d.id ? { ...n, x: nx, y: ny } : n)));
  }, []);

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    if (d?.mode === "node" && !d.moved) setSelectedId((cur) => (cur === d.id ? null : d.id));
    if (d?.mode === "pan") {
      if (!d.moved) setSelectedId(null);
      setPanning(false);
    }
    drag.current = null;
  }, []);

  const groupBoxes = useMemo(() => {
    return GROUPS.map((g) => {
      const members = nodes.filter((n) => n.group === g.id);
      if (members.length === 0) return null;
      return { group: g, bounds: groupBounds(members) };
    }).filter((b): b is { group: Group; bounds: ReturnType<typeof groupBounds> } => b !== null);
  }, [nodes]);

  const extent = useMemo(() => {
    const maxX = Math.max(1040, ...nodes.map((n) => n.x + NODE_W + 80));
    const maxY = Math.max(680, ...nodes.map((n) => n.y + nodeHeight(n) + 80));
    return { w: maxX, h: maxY };
  }, [nodes]);

  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <SubpageNav crumb="Service map" />

      <main className="mx-auto max-w-7xl px-6 pb-24 pt-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-[13px] font-medium text-muted">Storybook</span>
            <h1 className="mt-1.5 text-[30px] font-semibold tracking-tight text-fg">Service map</h1>
            <p className="mt-1.5 max-w-xl text-[14px] leading-relaxed text-muted">
              Drag a service to rearrange, click to expand it. Each service carries up to three
              signal badges — cost anomalies, security issues, and performance regressions — and
              lives inside a group.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Legend kind="cost" />
            <Legend kind="security" />
            <Legend kind="performance" />
            <span className="mx-0.5 h-5 w-px bg-border" />
            <button
              type="button"
              onClick={() => setShowGroups((s) => !s)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                showGroups ? "border-border-strong text-fg" : "border-border text-muted hover:text-fg"
              }`}
            >
              Groups
            </button>
            <button
              type="button"
              onClick={() => setShowDots((s) => !s)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                showDots ? "border-border-strong text-fg" : "border-border text-muted hover:text-fg"
              }`}
            >
              Dots
            </button>
          </div>
        </header>

        <div className="relative h-[680px]">
          {/* Canvas — fills the full canonical width */}
          <div
            ref={viewport}
            className={`absolute inset-0 overflow-hidden rounded-2xl border border-border ${
              panning ? "cursor-grabbing" : "cursor-grab"
            }`}
            style={{
              backgroundImage: showDots
                ? "radial-gradient(var(--dot-color) 1.25px, transparent 1.25px)"
                : undefined,
              backgroundSize: "22px 22px",
              backgroundPosition: `${pan.x - 1}px ${pan.y - 1}px`,
            }}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div
              className="absolute left-0 top-0"
              style={{ width: extent.w, height: extent.h, transform: `translate(${pan.x}px, ${pan.y}px)` }}
            >
                {/* Group containers */}
                {showGroups &&
                  groupBoxes.map(({ group, bounds }) => {
                    const tone = GROUP_TONE[group.tone];
                    return (
                      <div
                        key={group.id}
                        className="pointer-events-none absolute rounded-2xl"
                        style={{
                          left: bounds.x,
                          top: bounds.y,
                          width: bounds.w,
                          height: bounds.h,
                          border: `1px dashed ${tone.border}`,
                          background: tone.bg,
                        }}
                      >
                        <span
                          className="absolute left-3 top-3 rounded-md border bg-surface px-2 py-0.5 text-[12px] font-medium"
                          style={{ color: tone.label, borderColor: tone.border }}
                        >
                          {group.name}
                        </span>
                      </div>
                    );
                  })}

                {/* Edges */}
                <svg className="pointer-events-none absolute inset-0" width={extent.w} height={extent.h}>
                  <defs>
                    <marker
                      id="sm-arrow"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M0 0 L10 5 L0 10 z" fill="var(--color-subtle)" />
                    </marker>
                  </defs>
                  {EDGES.map((e) => {
                    const a = byId[e.from];
                    const b = byId[e.to];
                    if (!a || !b) return null;
                    const active = selectedId === e.from || selectedId === e.to;
                    return (
                      <path
                        key={`${e.from}-${e.to}`}
                        d={edgePath(a, b, nodeHeight(a), nodeHeight(b))}
                        fill="none"
                        stroke={active ? "var(--color-accent)" : "var(--color-subtle)"}
                        strokeWidth={active ? 1.75 : 1.25}
                        strokeOpacity={active ? 0.9 : 0.5}
                        markerEnd="url(#sm-arrow)"
                      />
                    );
                  })}
                </svg>

                {/* Nodes */}
                {nodes.map((node) => (
                  <ServiceCard
                    key={node.id}
                    node={node}
                    selected={selectedId === node.id}
                    onPointerDown={(e) => onNodePointerDown(e, node)}
                  />
                ))}
            </div>
          </div>

          {/* Inspector — floats over the canvas */}
          {selected && (
            <div className="pointer-events-none absolute inset-y-3 right-3 z-10 w-[340px] max-w-[calc(100%-24px)]">
              <Inspector node={selected} onClose={() => setSelectedId(null)} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Service card (node)
// ---------------------------------------------------------------------------

function ServiceCard({
  node,
  selected,
  onPointerDown,
}: {
  node: ServiceNode;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute cursor-grab touch-none select-none rounded-2xl bg-surface-2 transition-shadow active:cursor-grabbing"
      style={{
        left: node.x,
        top: node.y,
        width: NODE_W,
        // Double-outline halo: crisp inner border, a bg gap, then a faint ring.
        boxShadow: selected
          ? "0 0 0 1px var(--color-accent), 0 0 0 4px var(--color-surface), 0 0 0 5px rgba(72,90,226,0.35), 0 16px 32px -16px rgba(72,90,226,0.5)"
          : "0 0 0 1px var(--color-border-strong), 0 0 0 4px var(--color-surface), 0 0 0 5px rgba(255,255,255,0.04), 0 10px 24px -16px rgba(0,0,0,0.8)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3">
        <span className="h-[18px] w-[18px] shrink-0 text-muted">{KIND_ICON[node.kind] ?? KIND_ICON.service}</span>
        <span className="truncate text-[15px] font-semibold tracking-tight text-fg">{node.name}</span>
      </div>

      <div className="h-px bg-border" />

      {node.badges.length === 0 ? (
        <div className="px-4 py-2.5">
          <span className="text-[12.5px] text-subtle">No active signals</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
          {node.badges.map((b) => (
            <CompactBadge key={b.kind} badge={b} />
          ))}
        </div>
      )}
    </div>
  );
}

// A dashed leader row: label · · · · · · value.
function LeaderRow({ label, right }: { label: ReactNode; right: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-[13.5px] text-fg">{label}</span>
      <span className="h-px flex-1 self-center border-t border-dashed border-border-strong" />
      <span className="shrink-0">{right}</span>
    </div>
  );
}

// Solid pill when a signal is present (echoes the black "Enabled" pill),
// soft gray "Clear" pill otherwise (echoes the muted "Disabled" pill).
function SignalPill({ kind, count }: { kind: BadgeKind; count: number }) {
  const meta = BADGE_META[kind];
  if (count === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-surface-3 px-2.5 py-0.5 text-[12px] font-medium text-subtle">
        Clear
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold tabular-nums"
      style={{ background: meta.color, color: meta.ink }}
    >
      <span className="h-3 w-3">{meta.icon}</span>
      {count}
    </span>
  );
}

function CompactBadge({ badge }: { badge: Badge }) {
  const meta = BADGE_META[badge.kind];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums"
      style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 16%, transparent)` }}
      title={`${meta.label}: ${badge.count}`}
    >
      <span className="h-3 w-3">{meta.icon}</span>
      {badge.count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inspector panel
// ---------------------------------------------------------------------------

function Inspector({ node, onClose }: { node: ServiceNode | null; onClose: () => void }) {
  if (!node) return null;
  const group = GROUPS.find((g) => g.id === node.group);
  const totalSignals = node.badges.reduce((sum, b) => sum + b.count, 0);

  return (
    <div className="pointer-events-auto flex h-full flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <span className="h-[18px] w-[18px] shrink-0 text-muted">{KIND_ICON[node.kind] ?? KIND_ICON.service}</span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-tight text-fg">{node.name}</div>
          <div className="text-[12.5px] text-subtle">{node.kind}</div>
        </div>
        <span
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-medium"
          style={{ color: STATUS_COLOR[node.status] }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[node.status] }} />
          {STATUS_LABEL[node.status]}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div className="h-px bg-border" />

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <LeaderRow
          label={<span className="text-[13.5px] text-muted">Group</span>}
          right={
            group ? (
              <span
                className="rounded-md border px-2 py-0.5 text-[12.5px] font-medium"
                style={{ color: GROUP_TONE[group.tone].label, background: GROUP_TONE[group.tone].bg, borderColor: GROUP_TONE[group.tone].border }}
              >
                {group.name}
              </span>
            ) : null
          }
        />

        <div>
          <div className="mb-2.5 flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-muted">Signals</span>
            <span className="text-[12.5px] tabular-nums text-subtle">{totalSignals} open</span>
          </div>
          <div className="space-y-2">
            {BADGE_ORDER.map((kind) => {
              const meta = BADGE_META[kind];
              const count = node.badges.find((b) => b.kind === kind)?.count ?? 0;
              const present = count > 0;
              return (
                <div
                  key={kind}
                  className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 p-3"
                  style={{ opacity: present ? 1 : 0.6 }}
                >
                  <span
                    className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                    style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 16%, transparent)` }}
                  >
                    <span className="h-4 w-4">{meta.icon}</span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium text-fg">{meta.label}</span>
                      <span className="ml-auto shrink-0">
                        <SignalPill kind={kind} count={count} />
                      </span>
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                      {present ? meta.blurb(count) : "No findings in this category."}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="h-px bg-border" />
      <div className="flex gap-2 px-5 py-4">
        <Btn size="sm" variant="primary">
          Open service
        </Btn>
        <Btn size="sm" variant="ghost">
          Add badge
        </Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function Legend({ kind }: { kind: BadgeKind }) {
  const meta = BADGE_META[kind];
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
      <span className="h-3.5 w-3.5" style={{ color: meta.color }}>
        {meta.icon}
      </span>
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Subpage nav (mirrors the shared /design chrome)
// ---------------------------------------------------------------------------

function SubpageNav({ crumb }: { crumb: string }) {
  return (
    <header className="relative z-10">
      <div className="px-6">
        <nav className="flex items-center justify-start gap-3 py-5">
          <a href="/design" className="text-[14px] font-medium text-muted transition-opacity hover:text-fg">
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
