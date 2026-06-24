// ---------------------------------------------------------------------------
// Layered auto-layout (Sugiyama-lite), dependency-free.
//
// Our topologies are mostly left-to-right DAGs (edge → compute → data → external),
// so a longest-path layering + a couple of barycenter ordering sweeps gives a
// clean, deterministic arrangement without pulling in dagre/elk. Cycles (which a
// telemetry graph can contain) are tolerated: the layering is capped so it always
// terminates, and back-edges simply don't push their target further right.
//
// Output positions are top-left corners in canvas px. They are a STARTING point —
// once productionized, a user drag becomes a saved per-node override that wins
// over the computed value.
// ---------------------------------------------------------------------------

import type { Topology, TopologyNode } from "./topology.js";

export const NODE_W = 248;
export const NODE_H = 96; // header + one badge/empty row, matches the card renderer
const SERVICE_H = 156; // service cards carry a 2-line intent + a stats row, so they're taller
const BOUNDARY_H = 48; // a "talks to →" stub is a single compact row

/**
 * Rendered height of a node, in canvas px. Shared by the layout (vertical
 * stacking) and the renderer (edge-port geometry) so they never disagree. The
 * resource list lives in the drawer, so service cards are a fixed height; boundary
 * stubs are a single compact row.
 */
export function nodeCardHeight(n: TopologyNode): number {
  if (n.kind !== "service") return NODE_H;
  return n.meta?.boundary ? BOUNDARY_H : SERVICE_H;
}

// Vertical footprint a node reserves when stacked in a column. Service cards are
// taller than resource cards, so stacking by a flat NODE_H crammed them together.
const slotHeight = (n: TopologyNode): number => nodeCardHeight(n);

export type Density = "comfortable" | "compact";

export type LayoutOptions = {
  density?: Density;
  /** Extra top padding so group label tabs have room. */
  padTop?: number;
  padLeft?: number;
  /**
   * Swimlane mode: give each group its own horizontal band so group containers
   * never overlap. Nodes keep their dependency-layer X (left→right flow), but a
   * node's Y is determined by which lane its group occupies. Falls back to the
   * plain layered layout when there are no groups.
   */
  lanes?: boolean;
  /**
   * Wrap the layered layout to this pixel width: when the dependency chain is
   * wider than `maxWidth`, later layers reflow onto a new row band (like wrapping
   * text) at FULL node size — no zooming/scaling. Only applies to the plain
   * (non-swimlane) path. Omit for an un-wrapped single row.
   */
  maxWidth?: number;
};

export type Positioned = {
  positions: Map<string, { x: number; y: number }>;
  layers: Map<string, number>;
  extent: { w: number; h: number };
};

const GAPS: Record<Density, { h: number; v: number }> = {
  comfortable: { h: 120, v: 40 },
  compact: { h: 84, v: 24 },
};

/** Longest-path layering. layer(source)=0; layer(n)=max(layer(pred))+1. */
export function assignLayers(t: Topology): Map<string, number> {
  const layer = new Map<string, number>(t.nodes.map((n) => [n.id, 0]));
  const ids = new Set(layer.keys());
  const edges = t.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  // Relax up to |nodes| times (Bellman-Ford style). A valid DAG's longest path is
  // at most |nodes|-1, so clamping each layer there never affects a real DAG but
  // bounds (and thus terminates) layering when the graph contains a cycle.
  const cap = Math.max(0, t.nodes.length - 1);
  for (let pass = 0; pass < t.nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const next = (layer.get(e.from) ?? 0) + 1;
      if (next <= cap && next > (layer.get(e.to) ?? 0)) {
        layer.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

/**
 * Order nodes within each layer to reduce edge crossings, using a few barycenter
 * sweeps. Deterministic: initial order is by id, ties always broken by id.
 */
function orderWithinLayers(t: Topology, layer: Map<string, number>): Map<number, string[]> {
  const byLayer = new Map<number, string[]>();
  for (const n of [...t.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const l = layer.get(n.id) ?? 0;
    (byLayer.get(l) ?? byLayer.set(l, []).get(l)!).push(n.id);
  }

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of t.edges) {
    (succs.get(e.from) ?? succs.set(e.from, []).get(e.from)!).push(e.to);
    (preds.get(e.to) ?? preds.set(e.to, []).get(e.to)!).push(e.from);
  }

  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
  const indexInLayer = () => {
    const idx = new Map<string, number>();
    for (const l of layerKeys) byLayer.get(l)!.forEach((id, i) => idx.set(id, i));
    return idx;
  };

  const sweep = (neighbors: Map<string, string[]>, order: number[]) => {
    const idx = indexInLayer();
    for (const l of order) {
      const row = byLayer.get(l)!;
      const bary = new Map<string, number>();
      row.forEach((id, i) => {
        const ns = neighbors.get(id) ?? [];
        const positions = ns.map((m) => idx.get(m)).filter((v): v is number => v != null);
        bary.set(
          id,
          positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : i,
        );
      });
      row.sort((a, b) => {
        const d = (bary.get(a) ?? 0) - (bary.get(b) ?? 0);
        return d !== 0 ? d : a.localeCompare(b);
      });
    }
  };

  // A down sweep (order by predecessors) then up sweep (by successors), twice.
  for (let i = 0; i < 2; i++) {
    sweep(preds, layerKeys);
    sweep(succs, [...layerKeys].reverse());
  }
  return byLayer;
}

export function layoutTopology(t: Topology, opts: LayoutOptions = {}): Positioned {
  if (opts.lanes && t.groups.length > 0) return layoutSwimlanes(t, opts);

  const gap = GAPS[opts.density ?? "comfortable"];
  const padTop = opts.padTop ?? 64;
  const padLeft = opts.padLeft ?? 32;

  const layer = assignLayers(t);
  const byLayer = orderWithinLayers(t, layer);
  const nodeById = new Map(t.nodes.map((n) => [n.id, n]));
  const colW = NODE_W + gap.h;

  // How many layer-columns fit per row before we wrap to a new band.
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
  const fitCols = opts.maxWidth
    ? Math.floor((opts.maxWidth - 2 * padLeft + gap.h) / colW)
    : Number.POSITIVE_INFINITY;
  const maxCols = Math.max(1, Math.min(layerKeys.length, fitCols));

  // Height of each layer's vertical stack, then the height of each wrap band.
  const stackH = (ids: string[]) =>
    ids.reduce((h, id) => h + (slotHeight(nodeById.get(id) ?? FALLBACK) + gap.v), 0) - gap.v;
  const bandOf = (idx: number) => Math.floor(idx / maxCols);
  const bandHeight = new Map<number, number>();
  layerKeys.forEach((l, idx) => {
    const b = bandOf(idx);
    bandHeight.set(b, Math.max(bandHeight.get(b) ?? 0, stackH(byLayer.get(l)!)));
  });

  const BAND_GAP = gap.v * 2 + 28;
  const bandTop = new Map<number, number>();
  let cursor = padTop;
  for (const b of [...bandHeight.keys()].sort((a, b2) => a - b2)) {
    bandTop.set(b, cursor);
    cursor += (bandHeight.get(b) ?? 0) + BAND_GAP;
  }

  const positions = new Map<string, { x: number; y: number }>();
  layerKeys.forEach((l, idx) => {
    const col = idx % maxCols;
    const x = padLeft + col * colW;
    let y = bandTop.get(bandOf(idx)) ?? padTop;
    for (const id of byLayer.get(l)!) {
      positions.set(id, { x, y });
      y += slotHeight(nodeById.get(id) ?? FALLBACK) + gap.v;
    }
  });

  const colsUsed = Math.min(maxCols, layerKeys.length);
  const extent = {
    w: padLeft * 2 + Math.max(1, colsUsed) * NODE_W + Math.max(0, colsUsed - 1) * gap.h,
    h: cursor - BAND_GAP + padTop,
  };
  return { positions, layers: layer, extent };
}

// Stand-in node when a synthetic/unknown id has no record (keeps slotHeight total).
const FALLBACK = { id: "", kind: "compute", label: "", provider: "infra" } as const;

// Vertical room reserved above each lane for its group label tab + separation.
const LANE_TOP_PAD = 64;
const LANE_BOTTOM_PAD = 28;

/**
 * Swimlane layout: one horizontal band per group, stacked top-to-bottom in the
 * order `topology.groups` declares (ungrouped nodes get a trailing lane). Within
 * a lane, a node sits at its global dependency-layer X and is stacked vertically
 * when several of the lane's nodes share a layer. Group containers drawn around
 * these bands never overlap, while edges still flow left→right.
 */
function layoutSwimlanes(t: Topology, opts: LayoutOptions): Positioned {
  const gap = GAPS[opts.density ?? "comfortable"];
  const padLeft = opts.padLeft ?? 32;
  const layer = assignLayers(t);

  const laneIds = [...t.groups.map((g) => g.id), "__ungrouped__"];
  const nodesInLane = (laneId: string) =>
    t.nodes.filter((n) =>
      laneId === "__ungrouped__"
        ? !n.group || !t.groups.some((g) => g.id === n.group)
        : n.group === laneId,
    );

  const nodeById = new Map(t.nodes.map((n) => [n.id, n]));
  const positions = new Map<string, { x: number; y: number }>();
  let cursorY = opts.padTop ?? 24;
  let maxX = padLeft;

  for (const laneId of laneIds) {
    const members = nodesInLane(laneId);
    if (members.length === 0) continue;

    // Bucket the lane's members by layer, deterministic order within a column.
    const columns = new Map<number, string[]>();
    for (const n of [...members].sort((a, b) => a.id.localeCompare(b.id))) {
      const l = layer.get(n.id) ?? 0;
      (columns.get(l) ?? columns.set(l, []).get(l)!).push(n.id);
    }
    const laneTop = cursorY + LANE_TOP_PAD;
    let laneBottom = laneTop;
    for (const [l, ids] of columns) {
      const x = padLeft + l * (NODE_W + gap.h);
      let y = laneTop;
      for (const id of ids) {
        positions.set(id, { x, y });
        const node = nodeById.get(id);
        y += (node ? slotHeight(node) : NODE_H) + gap.v;
      }
      maxX = Math.max(maxX, x + NODE_W);
      laneBottom = Math.max(laneBottom, y - gap.v);
    }
    cursorY = laneBottom + LANE_BOTTOM_PAD;
  }

  const extent = { w: maxX + padLeft, h: cursorY + (opts.padTop ?? 24) };
  return { positions, layers: layer, extent };
}
