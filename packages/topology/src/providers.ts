// ---------------------------------------------------------------------------
// Topology providers
//
// A provider translates one domain source into a partial `Topology`. They are
// pure functions with no React/IO so they can run identically in the storybook
// (against baked fixtures) and, later, in the worker (against live inventory +
// ClickHouse). `mergeTopologies` reconciles the partials into one graph.
//
//   awsInfraProvider   — AWS resources → resource nodes + inferred infra edges
//   telemetryProvider  — observed service graph → service nodes + real edges
//   mergeTopologies    — union + de-dupe, reconciling ids via an alias map
// ---------------------------------------------------------------------------

import {
  type EdgeKind,
  type EdgeSource,
  type NodeKind,
  type NodeProvider,
  type Signal,
  type Topology,
  type TopologyEdge,
  type TopologyNode,
  edgeId,
} from "./topology.js";

// --- AWS infra provider ------------------------------------------------------

export type AwsResource = {
  /** Stable node id, e.g. "ecs:api". Providers own their id namespace. */
  id: string;
  kind: NodeKind;
  label: string;
  sublabel?: string;
  arn?: string;
  /** AWS service short name, e.g. "ecs", "rds", "sqs". */
  service?: string;
  tags?: Record<string, string>;
  signals?: Signal[];
  /**
   * Extra provider-specific detail folded into the node's `meta` bag — e.g. a
   * console deep-link, a headline `badge`, and per-kind `facts`. Kept generic so
   * the renderer never learns AWS specifics; it just displays what's here.
   */
  meta?: Record<string, unknown>;
};

export type AwsRelationship = {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
};

export type AwsInfraSnapshot = {
  resources: AwsResource[];
  relationships: AwsRelationship[];
};

export function awsInfraProvider(snapshot: AwsInfraSnapshot): Topology {
  const nodes: TopologyNode[] = snapshot.resources.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    sublabel: r.sublabel,
    provider: "infra" as NodeProvider,
    signals: r.signals,
    meta: { arn: r.arn, service: r.service, tags: r.tags, ...r.meta },
  }));
  const edges: TopologyEdge[] = snapshot.relationships.map((rel) => ({
    id: edgeId(rel.from, rel.to, rel.kind),
    from: rel.from,
    to: rel.to,
    kind: rel.kind,
    source: "infra" as EdgeSource,
    label: rel.label,
  }));
  return { nodes, edges, groups: [] };
}

// --- Telemetry provider ------------------------------------------------------

export type ServiceGraph = {
  /** Distinct emitting services (OTLP service.name). */
  services: { name: string; spans?: number; status?: TopologyNode["status"] }[];
  /** Observed cross-service calls (parent.service → child.service). */
  edges: { from: string; to: string; calls?: number }[];
  /** Observed outbound client spans to a non-service peer (DB / SaaS / queue). */
  externalDeps: {
    from: string;
    /** Peer host or system, e.g. "api.anthropic.com", "postgresql". */
    target: string;
    peerKind?: "db" | "messaging" | "http";
    calls?: number;
  }[];
};

/**
 * Map an OTLP service.name (or external peer) onto a canonical node id so the
 * same logical thing seen by infra + telemetry reconciles in merge. Returns the
 * canonical id, or undefined to keep the telemetry-native id.
 */
export type AliasResolver = (name: string) => string | undefined;

const compact = (n?: number): string | undefined => {
  if (n == null) return undefined;
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

export function telemetryProvider(
  graph: ServiceGraph,
  alias: AliasResolver = () => undefined,
): Topology {
  const resolve = (name: string) => alias(name) ?? `svc:${name}`;
  const resolveExternal = (target: string) => alias(target) ?? `ext:${target}`;

  // Materialize a service node for every declared service AND every edge
  // endpoint — an observed call implies both peers exist even if one of them
  // emitted no spans of its own in the window.
  const svcNodes = new Map<string, TopologyNode>();
  const ensureService = (name: string, extra?: Partial<TopologyNode>) => {
    const id = resolve(name);
    if (!svcNodes.has(id)) {
      svcNodes.set(id, {
        id,
        kind: "compute",
        label: name,
        provider: "telemetry",
        meta: { serviceName: name },
        ...extra,
      });
    }
  };
  for (const s of graph.services)
    ensureService(s.name, { status: s.status, meta: { spans: s.spans, serviceName: s.name } });
  for (const e of graph.edges) {
    ensureService(e.from);
    ensureService(e.to);
  }
  for (const dep of graph.externalDeps) ensureService(dep.from);

  const edges: TopologyEdge[] = graph.edges.map((e) => {
    const from = resolve(e.from);
    const to = resolve(e.to);
    return {
      id: edgeId(from, to, "calls"),
      from,
      to,
      kind: "calls" as EdgeKind,
      source: "telemetry" as EdgeSource,
      label: compact(e.calls) ? `${compact(e.calls)} calls` : undefined,
    };
  });

  // External dependencies become nodes (so they show up on the map) plus an edge.
  const extNodes = new Map<string, TopologyNode>();
  for (const dep of graph.externalDeps) {
    const id = resolveExternal(dep.target);
    if (!extNodes.has(id)) {
      const kind: NodeKind =
        dep.peerKind === "db" ? "database" : dep.peerKind === "messaging" ? "queue" : "external";
      extNodes.set(id, {
        id,
        kind,
        label: dep.target,
        provider: "telemetry",
        meta: { peer: dep.target, peerKind: dep.peerKind },
      });
    }
    const from = resolve(dep.from);
    const to = id;
    const kind: EdgeKind =
      dep.peerKind === "db" ? "reads" : dep.peerKind === "messaging" ? "enqueues" : "calls";
    edges.push({
      id: edgeId(from, to, kind),
      from,
      to,
      kind,
      source: "telemetry",
      label: compact(dep.calls),
    });
  }

  return { nodes: [...svcNodes.values(), ...extNodes.values()], edges, groups: [] };
}

// --- Merge -------------------------------------------------------------------

// Field precedence when two providers describe the same node: manual wins, then
// infra (canonical resource), then telemetry, then a prior merge result.
const NODE_PRECEDENCE: Record<NodeProvider, number> = {
  manual: 4,
  infra: 3,
  telemetry: 2,
  merged: 1,
};
// Edge precedence: a manual edge is intentional; telemetry is observed fact;
// infra is inferred; suggested is an AI guess.
const EDGE_PRECEDENCE: Record<EdgeSource, number> = {
  manual: 4,
  telemetry: 3,
  infra: 2,
  suggested: 1,
};

function mergeNode(a: TopologyNode, b: TopologyNode): TopologyNode {
  const [hi, lo] = NODE_PRECEDENCE[a.provider] >= NODE_PRECEDENCE[b.provider] ? [a, b] : [b, a];
  const signals = mergeSignals(a.signals, b.signals);
  return {
    ...lo,
    ...hi,
    // keep the richer label/sublabel if the winner lacks one
    label: hi.label || lo.label,
    sublabel: hi.sublabel ?? lo.sublabel,
    status: hi.status ?? lo.status,
    signals: signals.length ? signals : undefined,
    provider: a.provider === b.provider ? a.provider : "merged",
    aiProposed: a.aiProposed || b.aiProposed,
    meta: { ...lo.meta, ...hi.meta },
  };
}

function mergeSignals(a?: Signal[], b?: Signal[]): Signal[] {
  const by = new Map<string, number>();
  for (const s of [...(a ?? []), ...(b ?? [])])
    by.set(s.kind, Math.max(by.get(s.kind) ?? 0, s.count));
  return [...by.entries()].map(([kind, count]) => ({ kind: kind as Signal["kind"], count }));
}

const pairKey = (from: string, to: string) => `${from}${to}`;

/**
 * Merge any number of partial topologies into one. `aliases` rewrites node ids
 * (alias → canonical) on both nodes and edge endpoints *before* de-duping, so a
 * telemetry node "svc:superlog-api" and an infra node "ecs:api" collapse when
 * aliases maps "svc:superlog-api" → "ecs:api". Nodes de-dupe by id; edges
 * de-dupe by (from,to) keeping the highest-precedence source.
 */
export function mergeTopologies(
  partials: Topology[],
  aliases: Record<string, string> = {},
): Topology {
  const canon = (id: string) => aliases[id] ?? id;

  const nodes = new Map<string, TopologyNode>();
  for (const part of partials) {
    for (const raw of part.nodes) {
      const node = { ...raw, id: canon(raw.id) };
      const existing = nodes.get(node.id);
      nodes.set(node.id, existing ? mergeNode(existing, node) : node);
    }
  }

  const edges = new Map<string, TopologyEdge>();
  for (const part of partials) {
    for (const raw of part.edges) {
      const from = canon(raw.from);
      const to = canon(raw.to);
      if (from === to) continue; // canonicalization can collapse a self-loop
      const key = pairKey(from, to);
      const edge: TopologyEdge = { ...raw, id: edgeId(from, to, raw.kind), from, to };
      const existing = edges.get(key);
      if (!existing) {
        edges.set(key, edge);
      } else {
        const [hi, lo] =
          EDGE_PRECEDENCE[existing.source] >= EDGE_PRECEDENCE[edge.source]
            ? [existing, edge]
            : [edge, existing];
        edges.set(key, { ...hi, label: hi.label ?? lo.label });
      }
    }
  }

  // Drop dangling edges whose endpoints didn't survive (defensive).
  const liveEdges = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));

  const groups = dedupeGroups(partials.flatMap((p) => p.groups));
  return { nodes: [...nodes.values()], edges: liveEdges, groups };
}

function dedupeGroups(groups: Topology["groups"]): Topology["groups"] {
  const by = new Map<string, Topology["groups"][number]>();
  for (const g of groups) if (!by.has(g.id)) by.set(g.id, g);
  return [...by.values()];
}
