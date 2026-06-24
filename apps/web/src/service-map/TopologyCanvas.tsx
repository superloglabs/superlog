import { type Density, NODE_W, layoutTopology, nodeCardHeight } from "@superlog/topology";
import type {
  EdgeSource,
  NodeKind,
  Signal,
  SignalKind,
  Topology,
  TopologyEdge,
  TopologyGroup,
  TopologyNode,
} from "@superlog/topology";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Btn } from "../design/ui.tsx";

// ---------------------------------------------------------------------------
// TopologyCanvas — a data-driven renderer for the generic `Topology` model.
//
// Knows nothing about AWS/telemetry. It takes a Topology, auto-lays it out
// (overridable by dragging), and draws nodes, grouped containers, and edges
// styled by provenance: telemetry = solid (observed), infra = hairline
// (inferred), suggested = dashed + AI-marked (review me), manual = dashed.
// Pan + drag + an inspector are carried over from the original storyboard.
// ---------------------------------------------------------------------------

const HEADER_H = 56;
const BADGE_ROW_H = 40;
const PORT_Y = 28;
const PORT_GAP = 9;
const LR_THRESHOLD = 24;

// Focus-frame geometry: padding inside the boundary, room for its label tab, and
// the horizontal gap that pushes neighbour stubs clear of the frame.
const FRAME_PAD = 26;
const FRAME_LABEL_H = 16;
const STUB_GAP = 72;

type XY = { x: number; y: number };

function nodeHeight(node: TopologyNode): number {
  // Service + boundary cards are sized by the shared layout helper (member list /
  // stub), so renderer geometry and layout stacking never drift apart.
  if (node.kind === "service") return nodeCardHeight(node);
  const hasSignals = (node.signals?.length ?? 0) > 0;
  const hasSub = !!node.sublabel;
  return HEADER_H + (hasSub ? 16 : 0) + (hasSignals ? BADGE_ROW_H : 14);
}

// ---- visual tokens ---------------------------------------------------------

const KIND_ICON: Record<string, ReactNode> = {
  service: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  ),
  edge: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </svg>
  ),
  compute: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </svg>
  ),
  queue: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="7" width="4" height="10" rx="1" />
      <rect x="10" y="7" width="4" height="10" rx="1" />
      <rect x="17" y="7" width="4" height="10" rx="1" />
    </svg>
  ),
  database: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  ),
  cache: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
  storage: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7c0-1.7 4-3 9-3s9 1.3 9 3-4 3-9 3-9-1.3-9-3z" />
      <path d="M3 7v10c0 1.7 4 3 9 3s9-1.3 9-3V7" />
    </svg>
  ),
  external: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </svg>
  ),
};
const iconFor = (kind: NodeKind): ReactNode => KIND_ICON[kind] ?? KIND_ICON.compute;

const GROUP_TONE: Record<TopologyGroup["tone"], { border: string; bg: string; label: string }> = {
  accent: {
    border: "rgba(72,90,226,0.32)",
    bg: "rgba(72,90,226,0.05)",
    label: "var(--color-accent)",
  },
  success: {
    border: "rgba(65,209,149,0.28)",
    bg: "rgba(65,209,149,0.045)",
    label: "var(--color-success)",
  },
  warning: {
    border: "rgba(231,177,90,0.28)",
    bg: "rgba(231,177,90,0.045)",
    label: "var(--color-warning)",
  },
  danger: {
    border: "rgba(226,72,72,0.30)",
    bg: "rgba(226,72,72,0.05)",
    label: "var(--color-danger)",
  },
  neutral: {
    border: "rgba(255,255,255,0.12)",
    bg: "rgba(255,255,255,0.02)",
    label: "var(--color-muted)",
  },
};

const SIGNAL_META: Record<SignalKind, { color: string; label: string }> = {
  cost: { color: "var(--color-warning)", label: "Cost" },
  security: { color: "var(--color-danger)", label: "Security" },
  performance: { color: "var(--color-accent)", label: "Performance" },
};

// Edge styling keyed on provenance — the trust signal of the whole map.
const EDGE_STYLE: Record<
  EdgeSource,
  { stroke: string; width: number; opacity: number; dash?: string }
> = {
  telemetry: { stroke: "var(--color-accent)", width: 1.7, opacity: 0.85 },
  infra: { stroke: "var(--color-subtle)", width: 1.25, opacity: 0.5 },
  suggested: { stroke: "var(--color-accent)", width: 1.5, opacity: 0.7, dash: "5 4" },
  manual: { stroke: "var(--color-fg)", width: 1.4, opacity: 0.6, dash: "2 3" },
};

// Cards must be OPAQUE so edges routed behind them don't bleed through (the
// surface tokens are low-alpha overlays). Compose the surface tint over the page
// background so the fill is solid regardless of the token's alpha.
const CARD_BG =
  "linear-gradient(0deg, var(--color-surface-2), var(--color-surface-2)), var(--color-bg)";

// ---- geometry --------------------------------------------------------------

function edgePath(a: XY, b: XY, ha: number, hb: number): string {
  const G = PORT_GAP;
  const aRight = a.x + NODE_W;
  if (b.x >= aRight + LR_THRESHOLD) {
    const sx = aRight + G;
    const sy = a.y + PORT_Y;
    const tx = b.x - G;
    const ty = b.y + PORT_Y;
    const midX = sx + (tx - sx) / 2;
    return `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${ty} L ${tx} ${ty}`;
  }
  const sx = a.x + NODE_W / 2;
  const tx = b.x + NODE_W / 2;
  if (b.y >= a.y) {
    const sy = a.y + ha + G;
    const ty = b.y - G;
    const midY = sy + (ty - sy) / 2;
    return `M ${sx} ${sy} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${ty}`;
  }
  const sy = a.y - G;
  const ty = b.y + hb + G;
  const midY = sy + (ty - sy) / 2;
  return `M ${sx} ${sy} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${ty}`;
}

function groupBounds(positions: Map<string, XY>, nodes: TopologyNode[]) {
  const pts = nodes.map((n) => ({ p: positions.get(n.id)!, h: nodeHeight(n) })).filter((x) => x.p);
  const minX = Math.min(...pts.map((x) => x.p.x));
  const minY = Math.min(...pts.map((x) => x.p.y));
  const maxX = Math.max(...pts.map((x) => x.p.x + NODE_W));
  const maxY = Math.max(...pts.map((x) => x.p.y + x.h));
  const padX = 22;
  const padTop = 56;
  const padBottom = 22;
  return {
    x: minX - padX,
    y: minY - padTop,
    w: maxX - minX + padX * 2,
    h: maxY - minY + padTop + padBottom,
  };
}

// ---- component -------------------------------------------------------------

export function TopologyCanvas({
  topology,
  density = "comfortable",
  showGroups = true,
  showDots = true,
  height = 680,
  fitHeight = false,
  fitWidth = false,
  onNodeOpen,
  lockNodes = false,
  frame,
}: {
  topology: Topology;
  density?: Density;
  showGroups?: boolean;
  showDots?: boolean;
  height?: number | string;
  /**
   * When drilled into a group, the boundary frame to draw around the group's own
   * contents. Connected neighbour groups (boundary stubs) are pushed OUTSIDE this
   * frame so cross-group edges visibly cross the boundary.
   */
  frame?: { label: string; tone: TopologyGroup["tone"]; aiProposed?: boolean };
  /** Size the canvas to the laid-out content (clamped) instead of a fixed height. */
  fitHeight?: boolean;
  /** Zoom-to-fit the content to the canvas width (never upscaling) and centre it. */
  fitWidth?: boolean;
  /**
   * Called when a `service`-kind node is clicked, with the target service id
   * (from `node.meta.serviceId`). Used to drill into / hop between services.
   * Non-service nodes still open the inspector.
   */
  onNodeOpen?: (serviceId: string) => void;
  /** Pin nodes in their laid-out positions — clicks still work, dragging doesn't. */
  lockNodes?: boolean;
}) {
  const [viewportW, setViewportW] = useState(0);
  // Inside a frame, lay out ONLY the group's own contents — the neighbour stubs are
  // positioned outside the frame afterwards (see `display`), so they must not
  // inflate the inside DAG's width/spread.
  const layoutTopo = useMemo(() => {
    if (!frame) return topology;
    const stubIds = new Set(topology.nodes.filter((n) => n.meta?.boundary).map((n) => n.id));
    if (stubIds.size === 0) return topology;
    return {
      nodes: topology.nodes.filter((n) => !stubIds.has(n.id)),
      edges: topology.edges.filter((e) => !stubIds.has(e.from) && !stubIds.has(e.to)),
      groups: topology.groups,
    };
  }, [frame, topology]);
  // Wrap long chains to the canvas width (at full node size — no scaling). Inside a
  // frame, leave room for the outside stub columns + frame padding so the group's
  // contents wrap to fit rather than spilling under the neighbours / off-screen.
  const layoutMaxWidth = useMemo(() => {
    if (!fitWidth || viewportW <= 0) return undefined;
    if (!frame) return viewportW;
    const reserve = (NODE_W + STUB_GAP) * 2 + FRAME_PAD * 2 + 16;
    return Math.max(NODE_W + 80, viewportW - reserve);
  }, [fitWidth, viewportW, frame]);
  const layout = useMemo(
    () =>
      layoutTopology(layoutTopo, {
        density,
        lanes: showGroups,
        maxWidth: layoutMaxWidth,
      }),
    [layoutTopo, density, showGroups, layoutMaxWidth],
  );
  // node-id signature so positions reset when the graph (not just a drag) changes
  const sig = useMemo(
    () => topology.nodes.map((n) => n.id).join("|") + density + showGroups + viewportW,
    [topology, density, showGroups, viewportW],
  );

  const [positions, setPositions] = useState<Map<string, XY>>(() => new Map(layout.positions));
  useEffect(() => setPositions(new Map(layout.positions)), [sig, layout.positions]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pan, setPan] = useState<XY>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  // Track the canvas width so we can wrap + centre content.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const update = () => setViewportW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const drag = useRef<{
    mode: "node" | "pan";
    id?: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const byId = useMemo(() => new Map(topology.nodes.map((n) => [n.id, n])), [topology]);

  // Display positions: when a frame is set, relocate the neighbour boundary stubs
  // to columns just OUTSIDE the group's content bbox — upstream (something →
  // inside) on the left, downstream (inside → something) on the right — so the
  // frame encloses only the group's own resources and cross-group edges cross it.
  const display = useMemo(() => {
    if (!frame) return positions;
    const stubs = topology.nodes.filter((n) => n.meta?.boundary);
    if (stubs.length === 0) return positions;
    const inside = topology.nodes.filter((n) => !n.meta?.boundary);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const n of inside) {
      const p = positions.get(n.id);
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + nodeHeight(n));
    }
    if (!Number.isFinite(minX)) return positions;
    const cy = (minY + maxY) / 2;
    const left: string[] = [];
    const right: string[] = [];
    for (const s of stubs) {
      // downstream = the group depends on it (inside → stub) → place on the right.
      const downstream = topology.edges.some((e) => e.to === s.id);
      (downstream ? right : left).push(s.id);
    }
    const m = new Map(positions);
    const STUB_H = 48;
    const place = (ids: string[], x: number) => {
      const step = STUB_H + 18;
      let y = cy - (ids.length * step - 18) / 2;
      for (const id of ids) {
        m.set(id, { x, y });
        y += step;
      }
    };
    place(left, minX - STUB_GAP - NODE_W);
    place(right, maxX + STUB_GAP);
    // Left stubs (and the frame label) can land at negative coordinates; the edge
    // SVG starts at (0,0), so shift everything non-negative or its edges get clipped.
    let gMinX = Number.POSITIVE_INFINITY;
    let gMinY = Number.POSITIVE_INFINITY;
    for (const p of m.values()) {
      gMinX = Math.min(gMinX, p.x);
      gMinY = Math.min(gMinY, p.y);
    }
    const dx = gMinX < FRAME_PAD ? FRAME_PAD - gMinX : 0;
    const dy = gMinY < FRAME_PAD + FRAME_LABEL_H ? FRAME_PAD + FRAME_LABEL_H - gMinY : 0;
    if (dx || dy) for (const [k, p] of m) m.set(k, { x: p.x + dx, y: p.y + dy });
    return m;
  }, [frame, positions, topology.nodes, topology.edges]);

  // The frame rectangle around the group's own contents (boundary stubs excluded).
  const frameBox = useMemo(() => {
    if (!frame) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const n of topology.nodes) {
      if (n.meta?.boundary) continue;
      const p = display.get(n.id);
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + nodeHeight(n));
    }
    if (!Number.isFinite(minX)) return null;
    return {
      x: minX - FRAME_PAD,
      y: minY - FRAME_PAD - FRAME_LABEL_H,
      w: maxX - minX + FRAME_PAD * 2,
      h: maxY - minY + FRAME_PAD * 2 + FRAME_LABEL_H,
    };
  }, [frame, display, topology.nodes]);

  // Cross-boundary links connect a neighbour to the GROUP as a whole, not to the
  // individual member it happens to touch — anything else looks like the outside
  // group reaches inside the box. So we collapse every edge that crosses the frame
  // into a single connection per (neighbour, direction), drawn stub ↔ frame edge.
  const crossings = useMemo(() => {
    if (!frame || !frameBox) return [];
    const SOURCE_RANK: Record<EdgeSource, number> = {
      manual: 4,
      telemetry: 3,
      infra: 2,
      suggested: 1,
    };
    const byStub = new Map<string, { stubId: string; inbound: boolean; source: EdgeSource }>();
    for (const e of topology.edges) {
      const fromB = !!byId.get(e.from)?.meta?.boundary;
      const toB = !!byId.get(e.to)?.meta?.boundary;
      if (fromB === toB) continue; // both inside (real intra edge) or both stubs — skip
      const stubId = fromB ? e.from : e.to;
      const inbound = fromB; // stub is the source → arrow points into the group
      const key = `${stubId}:${inbound}`;
      const cur = byStub.get(key);
      if (!cur || SOURCE_RANK[e.source] > SOURCE_RANK[cur.source])
        byStub.set(key, { stubId, inbound, source: e.source });
    }
    return [...byStub.values()];
  }, [frame, frameBox, topology.edges, byId]);

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const neighbors = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const s = new Set<string>();
    for (const e of topology.edges) {
      if (e.from === selectedId) s.add(e.to);
      if (e.to === selectedId) s.add(e.from);
    }
    return s;
  }, [selectedId, topology.edges]);

  const onNodePointerDown = useCallback(
    (e: React.PointerEvent, node: TopologyNode) => {
      e.preventDefault();
      e.stopPropagation();
      viewport.current?.setPointerCapture?.(e.pointerId);
      const p = positions.get(node.id) ?? { x: 0, y: 0 };
      drag.current = {
        mode: "node",
        id: node.id,
        startX: e.clientX,
        startY: e.clientY,
        originX: p.x,
        originY: p.y,
        moved: false,
      };
    },
    [positions],
  );

  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      viewport.current?.setPointerCapture?.(e.pointerId);
      setPanning(true);
      drag.current = {
        mode: "pan",
        startX: e.clientX,
        startY: e.clientY,
        originX: pan.x,
        originY: pan.y,
        moved: false,
      };
    },
    [pan.x, pan.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === "pan") {
        if (Math.abs(dx) + Math.abs(dy) >= 3) d.moved = true;
        setPan({ x: d.originX + dx, y: d.originY + dy });
        return;
      }
      if (lockNodes) return; // nodes are pinned — drag is a no-op (click still fires on up)
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      d.moved = true;
      const nx = Math.max(0, d.originX + dx);
      const ny = Math.max(0, d.originY + dy);
      setPositions((prev) => new Map(prev).set(d.id!, { x: nx, y: ny }));
    },
    [lockNodes],
  );

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    if (d?.mode === "node" && !d.moved && d.id) {
      const node = byId.get(d.id);
      // Containers drill on the map: a group reveals its services, a service reveals
      // its resources, a boundary stub hops to that neighbour — all via onNodeOpen.
      // A leaf resource has nothing to drill into, so it opens the detail drawer.
      if (node?.kind === "service" && onNodeOpen) {
        const target = (node.meta?.serviceId as string | undefined) ?? node.id;
        onNodeOpen(target);
      } else {
        setSelectedId((cur) => (cur === d.id ? null : (d.id ?? null)));
      }
    }
    if (d?.mode === "pan") {
      if (!d.moved) setSelectedId(null);
      setPanning(false);
    }
    drag.current = null;
  }, [byId, onNodeOpen]);

  const groupBoxes = useMemo(() => {
    if (!showGroups) return [];
    return topology.groups
      .map((g) => {
        const members = topology.nodes.filter((n) => n.group === g.id && positions.get(n.id));
        if (members.length === 0) return null;
        return { group: g, bounds: groupBounds(positions, members) };
      })
      .filter(
        (b): b is { group: TopologyGroup; bounds: ReturnType<typeof groupBounds> } => b !== null,
      );
  }, [showGroups, topology.groups, topology.nodes, positions]);

  // True bounding box of the laid-out nodes (no padding floor) — drives zoom-to-fit
  // and centring.
  const content = useMemo(() => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const n of topology.nodes) {
      const p = display.get(n.id);
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + nodeHeight(n));
    }
    // Include the frame so a group whose stubs sit only on one side stays centred.
    if (frameBox) {
      minX = Math.min(minX, frameBox.x);
      minY = Math.min(minY, frameBox.y);
      maxX = Math.max(maxX, frameBox.x + frameBox.w);
      maxY = Math.max(maxY, frameBox.y + frameBox.h);
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 0, h: 0 };
    return { minX, minY, w: maxX - minX, h: maxY - minY };
  }, [topology.nodes, display, frameBox]);

  // The scrollable inner-layer size (kept generous so the SVG/background cover pans).
  const extent = useMemo(
    () => ({
      w: Math.max(1040, content.minX + content.w + 80),
      h: Math.max(600, content.minY + content.h + 80),
    }),
    [content],
  );

  // No scaling — content is wrapped to fit width at full size, then centred.
  const resolvedHeight = fitHeight
    ? Math.min(1640, Math.max(360, Math.round(content.h + 96)))
    : height;
  const vh = typeof resolvedHeight === "number" ? resolvedHeight : content.h + 96;
  // Centre the content box when it fits; once it's wider than the viewport, pin the
  // chain's left edge to a small pad instead (centring would push the start of a
  // left-to-right map off-screen — the user pans right to follow it).
  const PAD_X = 24;
  const baseX =
    content.w <= viewportW - PAD_X * 2
      ? (viewportW - content.w) / 2 - content.minX
      : PAD_X - content.minX;
  const baseY = (vh - content.h) / 2 - content.minY;

  return (
    <div className="relative w-full" style={{ height: resolvedHeight }}>
      <div
        ref={viewport}
        className={`absolute inset-0 overflow-hidden rounded-2xl border border-border ${panning ? "cursor-grabbing" : "cursor-grab"}`}
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
          style={{
            width: extent.w,
            height: extent.h,
            transform: `translate(${baseX + pan.x}px, ${baseY + pan.y}px)`,
            transformOrigin: "0 0",
          }}
        >
          {/* Focus frame: the boundary around the drilled group's own contents.
              Neighbour stubs are positioned outside it; edges cross the border. */}
          {frame && frameBox && (
            <div
              className="pointer-events-none absolute rounded-[20px]"
              style={{
                left: frameBox.x,
                top: frameBox.y,
                width: frameBox.w,
                height: frameBox.h,
                border: `1.5px dashed ${GROUP_TONE[frame.tone].border}`,
                background: GROUP_TONE[frame.tone].bg,
              }}
            >
              <span
                className="absolute left-3 top-0 inline-flex -translate-y-1/2 items-center gap-1.5 rounded-md border bg-surface px-2 py-0.5 text-[12px] font-medium"
                style={{
                  color: GROUP_TONE[frame.tone].label,
                  borderColor: GROUP_TONE[frame.tone].border,
                }}
              >
                {frame.label}
                {frame.aiProposed && <AiDot />}
              </span>
            </div>
          )}

          {/* Group containers */}
          {groupBoxes.map(({ group, bounds }) => {
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
                  className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-md border bg-surface px-2 py-0.5 text-[12px] font-medium"
                  style={{ color: tone.label, borderColor: tone.border }}
                >
                  {group.label}
                  {group.aiProposed && <AiDot />}
                </span>
              </div>
            );
          })}

          {/* Edges */}
          <svg className="pointer-events-none absolute inset-0" width={extent.w} height={extent.h}>
            <defs>
              <marker
                id="tc-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" fill="var(--color-subtle)" />
              </marker>
              <marker
                id="tc-arrow-active"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6.5"
                markerHeight="6.5"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" fill="var(--color-accent)" />
              </marker>
            </defs>
            {topology.edges
              // In a framed view the boundary-crossing edges are drawn separately
              // (stub ↔ frame); the normal pass handles only the group's own
              // internal wiring. At the root nothing is a stub, so all edges pass.
              .filter((e) => {
                if (!frame) return true;
                const fromB = !!byId.get(e.from)?.meta?.boundary;
                const toB = !!byId.get(e.to)?.meta?.boundary;
                return fromB === toB;
              })
              .map((e) => {
                const a = display.get(e.from);
                const b = display.get(e.to);
                const na = byId.get(e.from);
                const nb = byId.get(e.to);
                if (!a || !b || !na || !nb) return null;
                const active = selectedId === e.from || selectedId === e.to;
                const style = EDGE_STYLE[e.source];
                return (
                  <g key={e.id}>
                    <path
                      d={edgePath(a, b, nodeHeight(na), nodeHeight(nb))}
                      fill="none"
                      stroke={active ? "var(--color-accent)" : style.stroke}
                      strokeWidth={active ? style.width + 0.6 : style.width}
                      strokeOpacity={active ? 1 : selectedId ? 0.18 : style.opacity}
                      strokeDasharray={style.dash}
                      markerEnd={active ? "url(#tc-arrow-active)" : "url(#tc-arrow)"}
                    />
                  </g>
                );
              })}

            {/* Boundary crossings: connect each neighbour to the frame edge itself. */}
            {frame &&
              frameBox &&
              crossings.map((c) => {
                const sp = display.get(c.stubId);
                if (!sp) return null;
                const stub = byId.get(c.stubId);
                const stubH = stub ? nodeHeight(stub) : 48;
                const leftSide = sp.x < frameBox.x;
                const stubInner = leftSide ? sp.x + NODE_W : sp.x;
                const frameX = leftSide ? frameBox.x : frameBox.x + frameBox.w;
                // Land on the frame edge at the neighbour's height, clamped to the
                // frame so the arrow always meets the border.
                const y = Math.max(
                  frameBox.y + 12,
                  Math.min(frameBox.y + frameBox.h - 12, sp.y + stubH / 2),
                );
                const start = c.inbound ? stubInner : frameX;
                const end = c.inbound ? frameX : stubInner;
                const style = EDGE_STYLE[c.source];
                return (
                  <path
                    key={`${c.stubId}:${c.inbound}`}
                    d={`M ${start} ${y} L ${end} ${y}`}
                    fill="none"
                    stroke={style.stroke}
                    strokeWidth={style.width}
                    strokeOpacity={selectedId ? 0.18 : style.opacity}
                    strokeDasharray={style.dash}
                    markerEnd="url(#tc-arrow)"
                  />
                );
              })}
          </svg>

          {/* Nodes */}
          {topology.nodes.map((node) => {
            const p = display.get(node.id);
            if (!p) return null;
            const dimmed = !!selectedId && selectedId !== node.id && !neighbors.has(node.id);
            return (
              <NodeCard
                key={node.id}
                node={node}
                pos={p}
                selected={selectedId === node.id}
                dimmed={dimmed}
                locked={lockNodes}
                onPointerDown={(e) => onNodePointerDown(e, node)}
              />
            );
          })}
        </div>
      </div>

      {selected && (
        <div className="pointer-events-none absolute inset-y-3 right-3 z-10 w-[340px] max-w-[calc(100%-24px)]">
          <Inspector node={selected} topology={topology} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}

// ---- node card -------------------------------------------------------------

function NodeCard({
  node,
  pos,
  selected,
  dimmed,
  locked,
  onPointerDown,
}: {
  node: TopologyNode;
  pos: XY;
  selected: boolean;
  dimmed: boolean;
  locked?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  if (node.kind === "service")
    return <ServiceCard node={node} pos={pos} dimmed={dimmed} onPointerDown={onPointerDown} />;
  return (
    <div
      onPointerDown={onPointerDown}
      className={`absolute touch-none select-none rounded-2xl transition-[box-shadow,opacity] ${locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
      style={{
        left: pos.x,
        top: pos.y,
        width: NODE_W,
        background: CARD_BG,
        opacity: dimmed ? 0.35 : 1,
        boxShadow: selected
          ? "0 0 0 1px var(--color-accent), 0 0 0 4px var(--color-surface), 0 0 0 5px rgba(72,90,226,0.35), 0 16px 32px -16px rgba(72,90,226,0.5)"
          : "0 0 0 1px var(--color-border-strong), 0 0 0 4px var(--color-surface), 0 0 0 5px rgba(255,255,255,0.04), 0 10px 24px -16px rgba(0,0,0,0.8)",
      }}
    >
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
        <span className="h-[18px] w-[18px] shrink-0 text-muted">{iconFor(node.kind)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-semibold tracking-tight text-fg">
              {node.label}
            </span>
            {node.aiProposed && <AiDot />}
            {node.status && node.status !== "unknown" && <StatusDot status={node.status} />}
          </div>
          {node.sublabel && (
            <div className="truncate text-[11.5px] text-subtle">{node.sublabel}</div>
          )}
        </div>
        {typeof node.meta?.console === "string" && (
          <a
            href={node.meta.console}
            target="_blank"
            rel="noreferrer"
            onPointerDown={(e) => e.stopPropagation()}
            title="Open in AWS console"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ExtLink />
          </a>
        )}
      </div>

      <div className="h-px bg-border" />

      {node.signals && node.signals.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
          {node.signals.map((s) => (
            <SignalBadge key={s.kind} signal={s} />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-2">
          <span className="text-[11.5px] capitalize text-subtle">{node.kind}</span>
          {typeof node.meta?.badge === "string" && (
            <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-muted">
              {node.meta.badge}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Distinct rendering for collapsed services + boundary stubs (the top level and
// the "talks to →" markers inside an exploded service).
function ServiceCard({
  node,
  pos,
  dimmed,
  onPointerDown,
}: {
  node: TopologyNode;
  pos: XY;
  dimmed: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const tone = (node.meta?.tone as TopologyGroup["tone"] | undefined) ?? "neutral";
  const t = GROUP_TONE[tone];
  const boundary = !!node.meta?.boundary;

  if (boundary) {
    // Faded via muted colours + dashed border, NOT via opacity — an opacity on the
    // whole card makes its background translucent, letting edges bleed through it.
    return (
      <div
        onPointerDown={onPointerDown}
        className="absolute flex cursor-pointer touch-none select-none items-center gap-2 rounded-xl border border-dashed px-3 py-2.5"
        style={{
          left: pos.x,
          top: pos.y,
          width: NODE_W,
          background: CARD_BG,
          borderColor: t.border,
          opacity: dimmed ? 0.35 : 1,
        }}
        title={`Open ${node.label}`}
      >
        <span className="h-[16px] w-[16px] shrink-0 opacity-70" style={{ color: t.label }}>
          {iconFor("service")}
        </span>
        <span className="truncate text-[13px] font-medium text-subtle">{node.label}</span>
        <span className="ml-auto shrink-0 text-subtle">
          <Chevron />
        </span>
      </div>
    );
  }

  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute cursor-pointer touch-none select-none rounded-2xl transition-[box-shadow,opacity] hover:brightness-110"
      style={{
        left: pos.x,
        top: pos.y,
        width: NODE_W,
        background: CARD_BG,
        opacity: dimmed ? 0.35 : 1,
        boxShadow: `0 0 0 1px ${t.border}, 0 0 0 4px var(--color-surface), 0 0 0 5px ${t.bg}, 0 12px 28px -16px rgba(0,0,0,0.85)`,
      }}
    >
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
          style={{ color: t.label, background: t.bg }}
        >
          <span className="h-[16px] w-[16px]">{iconFor("service")}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold tracking-tight text-fg">
              {node.label}
            </span>
            {node.aiProposed && <AiDot />}
          </div>
          {node.sublabel && (
            <div className="line-clamp-2 text-[11.5px] leading-snug text-subtle">
              {node.sublabel}
            </div>
          )}
        </div>
      </div>

      <div className="h-px bg-border" />

      {/* No counts on the card — you open it to see what's inside. */}
      <div className="flex items-center px-4 py-2.5">
        <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-muted">
          Open
          <Chevron />
        </span>
      </div>

      {node.signals && node.signals.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5">
          {node.signals.map((s) => (
            <SignalBadge key={s.kind} signal={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function ExtLink() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3"
    >
      <path d="M15 3h6v6M10 14 21 3M18 13v8H3V6h8" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-3.5 w-3.5"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function StatusDot({ status }: { status: NonNullable<TopologyNode["status"]> }) {
  const color =
    status === "healthy"
      ? "var(--color-success)"
      : status === "degraded"
        ? "var(--color-warning)"
        : "var(--color-danger)";
  return (
    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} title={status} />
  );
}

function AiDot() {
  return (
    <span
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-accent"
      title="AI suggestion — review"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
        <path d="M12 2l1.6 4.8L18 8l-4.4 1.2L12 14l-1.6-4.8L6 8l4.4-1.2L12 2z" />
      </svg>
    </span>
  );
}

function SignalBadge({ signal }: { signal: Signal }) {
  const meta = SIGNAL_META[signal.kind];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums"
      style={{
        color: meta.color,
        background: `color-mix(in srgb, ${meta.color} 16%, transparent)`,
      }}
      title={`${meta.label}: ${signal.count}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
      {signal.count}
    </span>
  );
}

// ---- inspector -------------------------------------------------------------

function Inspector({
  node,
  topology,
  onClose,
}: { node: TopologyNode; topology: Topology; onClose: () => void }) {
  const group = topology.groups.find((g) => g.id === node.group);
  const inbound = topology.edges.filter((e) => e.to === node.id);
  const outbound = topology.edges.filter((e) => e.from === node.id);
  const labelFor = (id: string) => topology.nodes.find((n) => n.id === id)?.label ?? id;
  const facts = (node.meta?.facts as { label: string; value: string }[] | undefined) ?? [];
  const console_ = typeof node.meta?.console === "string" ? node.meta.console : undefined;

  return (
    <div className="pointer-events-auto flex h-full flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <span className="h-[18px] w-[18px] shrink-0 text-muted">{iconFor(node.kind)}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold tracking-tight text-fg">
              {node.label}
            </span>
            {node.aiProposed && <AiDot />}
          </div>
          <div className="text-[12px] text-subtle">
            <span className="capitalize">{node.kind}</span>
            <span className="text-subtle"> · {node.provider}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-lg text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div className="h-px bg-border" />
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {group && (
          <Row label="Group">
            <span
              className="rounded-md border px-2 py-0.5 text-[12px] font-medium"
              style={{
                color: GROUP_TONE[group.tone].label,
                background: GROUP_TONE[group.tone].bg,
                borderColor: GROUP_TONE[group.tone].border,
              }}
            >
              {group.label}
            </span>
          </Row>
        )}
        {node.sublabel && (
          <Row label="Detail">
            <span className="text-[12.5px] text-fg">{node.sublabel}</span>
          </Row>
        )}
        {facts.map((f) => (
          <Row key={f.label} label={f.label}>
            <span className="text-[12.5px] text-fg">{f.value}</span>
          </Row>
        ))}
        <EdgeList title="Depends on" edges={outbound} dir="out" labelFor={labelFor} />
        <EdgeList title="Used by" edges={inbound} dir="in" labelFor={labelFor} />
      </div>
      <div className="h-px bg-border" />
      <div className="flex gap-2 px-5 py-4">
        {console_ ? (
          <a
            href={console_}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Open in AWS
            <ExtLink />
          </a>
        ) : (
          <Btn size="sm" variant="primary">
            Open
          </Btn>
        )}
        <Btn size="sm" variant="ghost">
          Reassign group
        </Btn>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-[13px] text-muted">{label}</span>
      <span className="h-px flex-1 self-center border-t border-dashed border-border-strong" />
      <span className="shrink-0">{children}</span>
    </div>
  );
}

const EDGE_SOURCE_LABEL: Record<EdgeSource, string> = {
  telemetry: "observed",
  infra: "inferred",
  suggested: "AI",
  manual: "manual",
};

function EdgeList({
  title,
  edges,
  dir,
  labelFor,
}: { title: string; edges: TopologyEdge[]; dir: "in" | "out"; labelFor: (id: string) => string }) {
  if (edges.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-muted">{title}</div>
      <div className="space-y-1.5">
        {edges.map((e) => (
          <div
            key={e.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5"
          >
            <span className="truncate text-[12.5px] text-fg">
              {labelFor(dir === "out" ? e.to : e.from)}
            </span>
            {e.label && <span className="shrink-0 text-[11px] text-subtle">{e.label}</span>}
            <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-subtle">
              {EDGE_SOURCE_LABEL[e.source]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- shared legend (exported for the playground header) --------------------

export function EdgeLegend() {
  const items: { source: EdgeSource; label: string }[] = [
    { source: "telemetry", label: "Observed" },
    { source: "infra", label: "Inferred" },
    { source: "suggested", label: "AI suggested" },
  ];
  return (
    <div className="flex items-center gap-3">
      {items.map((it) => {
        const s = EDGE_STYLE[it.source];
        return (
          <span
            key={it.source}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-muted"
          >
            <svg width="22" height="6" viewBox="0 0 22 6">
              <line
                x1="0"
                y1="3"
                x2="22"
                y2="3"
                stroke={s.stroke}
                strokeWidth={s.width + 0.4}
                strokeOpacity={Math.max(s.opacity, 0.7)}
                strokeDasharray={s.dash}
              />
            </svg>
            {it.label}
          </span>
        );
      })}
    </div>
  );
}
