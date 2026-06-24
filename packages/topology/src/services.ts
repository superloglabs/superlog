// ---------------------------------------------------------------------------
// Hierarchical service view
//
// The LLM groups resources into a TREE of logical services (groups with a
// `parentId`): e.g. "Telemetry pipeline" contains a "ClickHouse cluster" sub-group
// which contains the keeper/replica resources. `viewTopology(t, focusId)` renders
// ONE level of that tree:
//
//   • focusId = null  → the top-level services.
//   • focusId = a group → that group's direct children: nested sub-services
//     (collapsed) + any resources assigned directly to it, with faded "boundary"
//     stubs to the neighbouring top-level services it talks to (click to hop).
//
// Edges are aggregated to whatever each endpoint's representative is AT this level.
// Always returns a plain `Topology`, so the same canvas renders any level.
// ---------------------------------------------------------------------------

import type {
  EdgeSource,
  Topology,
  TopologyEdge,
  TopologyGroup,
  TopologyNode,
} from "./topology.js";

const SERVICE_PREFIX = "service:";
const BOUNDARY_PREFIX = "boundary:";

export const serviceNodeId = (groupId: string) => `${SERVICE_PREFIX}${groupId}`;

// How many member resources a service card lists before "+N more".
const MEMBER_CAP = 6;

/** A compact descriptor of one resource inside a service, for the card's list. */
export type ServiceMember = {
  id: string;
  label: string;
  kind: string;
  /** Headline fact (e.g. "3/3 tasks", "db.t4g.medium"), from the node's meta. */
  badge?: string;
  /** AWS console deep-link, from the node's meta. */
  console?: string;
};

const memberOf = (n: TopologyNode): ServiceMember => ({
  id: n.id,
  label: n.label,
  kind: n.kind,
  badge: typeof n.meta?.badge === "string" ? n.meta.badge : undefined,
  console: typeof n.meta?.console === "string" ? n.meta.console : undefined,
});

// Datastores and entrypoints are what a human scans a service for; surface them
// before generic compute, then sort by label so the list is stable run-to-run.
const MEMBER_KIND_RANK: Record<string, number> = {
  edge: 0,
  database: 1,
  cache: 1,
  queue: 1,
  storage: 2,
  compute: 3,
};
const memberOrder = (a: ServiceMember, b: ServiceMember): number => {
  const ra = MEMBER_KIND_RANK[a.kind] ?? 4;
  const rb = MEMBER_KIND_RANK[b.kind] ?? 4;
  return ra !== rb ? ra - rb : a.label.localeCompare(b.label);
};

const EDGE_RANK: Record<EdgeSource, number> = { manual: 4, telemetry: 3, infra: 2, suggested: 1 };

type Groups = TopologyGroup[];
const groupById = (groups: Groups) => new Map(groups.map((g) => [g.id, g]));
const parentOf = (
  groups: Map<string, TopologyGroup>,
  id: string | null | undefined,
): string | null => (id ? (groups.get(id)?.parentId ?? null) : null);

/**
 * The ancestor of `leaf` that is a DIRECT child of `focus` (or `leaf` itself if it
 * is). Returns null when `leaf` is not inside `focus`'s subtree. focus=null = root.
 */
function childUnder(
  groups: Map<string, TopologyGroup>,
  leaf: string | null | undefined,
  focus: string | null,
): string | null {
  let g: string | null = leaf ?? null;
  const seen = new Set<string>();
  while (g != null && !seen.has(g)) {
    seen.add(g);
    const p = parentOf(groups, g);
    if (p === focus) return g;
    g = p;
  }
  return null;
}

/** Breadcrumb path root→focus, as [{id,label}] (excludes the synthetic root). */
export function groupPath(t: Topology, focusId: string | null): { id: string; label: string }[] {
  if (!focusId) return [];
  const groups = groupById(t.groups);
  const chain: { id: string; label: string }[] = [];
  let g: string | null = focusId;
  const seen = new Set<string>();
  while (g != null && !seen.has(g)) {
    seen.add(g);
    const grp = groups.get(g);
    if (!grp) break;
    chain.unshift({ id: grp.id, label: grp.label });
    g = grp.parentId ?? null;
  }
  return chain;
}

/** True if `focusId` is a leaf group (no child groups) — i.e. it holds resources directly. */
export function isLeafGroup(t: Topology, focusId: string): boolean {
  return !t.groups.some((g) => g.parentId === focusId);
}

export function viewTopology(t: Topology, focusId: string | null = null): Topology {
  const groups = groupById(t.groups);
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const focus = focusId ?? null;

  // What represents node `id` at this focus level: itself (direct resource), a
  // child service-group, or a boundary stub to its top-level ancestor.
  type Rep =
    | { kind: "direct"; id: string }
    | { kind: "service"; gid: string }
    | { kind: "boundary"; gid: string | null };
  const repOf = (id: string): Rep | null => {
    const n = byId.get(id);
    if (!n) return null;
    if ((n.group ?? null) === focus) return { kind: "direct", id };
    const child = childUnder(groups, n.group, focus);
    if (child) return { kind: "service", gid: child };
    return { kind: "boundary", gid: childUnder(groups, n.group, null) };
  };
  const repId = (r: Rep): string =>
    r.kind === "direct"
      ? r.id
      : r.kind === "service"
        ? serviceNodeId(r.gid)
        : `${BOUNDARY_PREFIX}${r.gid}`;

  // --- nodes ---------------------------------------------------------------
  const childCounts = new Map<string, number>();
  const childKinds = new Map<string, Map<string, number>>();
  const childMembers = new Map<string, ServiceMember[]>();
  const directNodes: TopologyNode[] = [];
  for (const n of t.nodes) {
    if ((n.group ?? null) === focus) {
      directNodes.push(n);
      continue;
    }
    const child = childUnder(groups, n.group, focus);
    if (!child) continue; // not in this subtree
    childCounts.set(child, (childCounts.get(child) ?? 0) + 1);
    const km = childKinds.get(child) ?? new Map();
    km.set(n.kind, (km.get(n.kind) ?? 0) + 1);
    childKinds.set(child, km);
    const ms = childMembers.get(child) ?? [];
    ms.push(memberOf(n));
    childMembers.set(child, ms);
  }

  const serviceNodes: TopologyNode[] = [...childCounts.keys()].map((gid) => {
    const g = groups.get(gid);
    const members = childMembers.get(gid) ?? [];
    return {
      id: serviceNodeId(gid),
      kind: "service",
      label: g?.label ?? gid,
      sublabel: g?.intent,
      provider: "merged",
      aiProposed: g?.aiProposed,
      meta: {
        serviceId: gid,
        memberCount: childCounts.get(gid) ?? 0,
        kinds: Object.fromEntries(childKinds.get(gid) ?? []),
        // The concrete resources inside, so the card can list them (capped; the
        // count above is the true total). Datastores/edges first — the things a
        // human scans for — then by label for stability.
        members: [...members].sort(memberOrder).slice(0, MEMBER_CAP),
        tone: g?.tone,
        hasChildren: t.groups.some((x) => x.parentId === gid),
      },
    };
  });

  // --- edges + boundary stubs ---------------------------------------------
  const out: TopologyNode[] = [...serviceNodes, ...directNodes];
  const boundary = new Map<string, TopologyNode>();
  const agg = new Map<
    string,
    { from: string; to: string; count: number; source: EdgeSource; kind?: string }
  >();

  for (const e of t.edges) {
    const ra = repOf(e.from);
    const rb = repOf(e.to);
    if (!ra || !rb) continue;
    const fromId = repId(ra);
    const toId = repId(rb);
    if (fromId === toId) continue; // intra
    // An edge between two OUTSIDE neighbours is noise at this focus level — it
    // neither touches the focused group's contents nor warrants materialising a
    // neighbour node. Skip it entirely (so no orphan boundary stub is created).
    if (ra.kind === "boundary" && rb.kind === "boundary") continue;
    // a boundary endpoint must reference an actual neighbouring service
    for (const [r, id] of [
      [ra, fromId],
      [rb, toId],
    ] as const) {
      if (r.kind === "boundary" && r.gid && !boundary.has(id)) {
        const g = groups.get(r.gid);
        boundary.set(id, {
          id,
          kind: "service",
          label: g?.label ?? r.gid,
          provider: "merged",
          meta: { serviceId: r.gid, boundary: true, tone: g?.tone },
        });
      }
    }
    // skip edges where a boundary endpoint couldn't resolve
    if (ra.kind === "boundary" && !ra.gid) continue;
    if (rb.kind === "boundary" && !rb.gid) continue;
    const key = `${fromId}\u001f${toId}`; // unit separator — ids can't contain it
    const cur = agg.get(key);
    if (!cur) agg.set(key, { from: fromId, to: toId, count: 1, source: e.source, kind: e.kind });
    else {
      cur.count++;
      if (EDGE_RANK[e.source] > EDGE_RANK[cur.source]) cur.source = e.source;
    }
  }

  const allNodes = [...out, ...boundary.values()];
  const liveIds = new Set(allNodes.map((n) => n.id));
  const edges: TopologyEdge[] = [...agg.values()]
    .filter((a) => liveIds.has(a.from) && liveIds.has(a.to))
    .map((a) => ({
      id: `${a.from}->${a.to}`,
      from: a.from,
      to: a.to,
      source: a.source,
      // A collapsed service endpoint (on EITHER side) aggregates many underlying
      // links → show the count; a direct resource→resource edge keeps its verb.
      label:
        a.from.startsWith(SERVICE_PREFIX) || a.to.startsWith(SERVICE_PREFIX)
          ? `${a.count} ${a.count === 1 ? "link" : "links"}`
          : a.kind,
      kind: a.kind,
    }));

  return { nodes: allNodes, edges, groups: [] };
}
