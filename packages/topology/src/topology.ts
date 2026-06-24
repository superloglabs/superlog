// ---------------------------------------------------------------------------
// Generic topology model
//
// The renderer (TopologyCanvas) knows nothing about AWS, telemetry, or any
// specific domain — it draws a `Topology`. Domain sources are translated into
// this model by *providers* (providers.ts), and an optional LLM refinement pass
// (enrich.ts) layers reviewable suggestions on top. Adding a new kind of map =
// adding a new provider, never touching the renderer. That's the extensibility
// seam the feature is built around.
// ---------------------------------------------------------------------------

// Node kinds are an OPEN union: the listed members get first-class icons/styling,
// but any string is accepted so new providers can introduce their own kinds
// without a renderer change (unknown kinds fall back to a generic glyph).
export type NodeKind =
  | "service" // a logical service (collapsed group of resources) — the top level
  | "edge" // internet-facing entrypoint (LB, CDN, gateway)
  | "compute" // a running service (ECS task, container, function, process)
  | "queue" // message queue / stream (SQS, Kafka, Kinesis)
  | "database" // OLTP/OLAP store (RDS, ClickHouse, Dynamo)
  | "cache" // Redis / Memcached
  | "storage" // object store (S3, GCS)
  | "external" // a third-party dependency we call out to (SaaS API)
  | "group-anchor" // synthetic node used only for layout, never rendered
  | (string & {});

export type NodeStatus = "healthy" | "degraded" | "down" | "unknown";

// Provenance of a node: which provider asserted it. Drives subtle styling and
// lets merge() reconcile the same logical thing seen by two providers.
export type NodeProvider = "infra" | "telemetry" | "manual" | "merged";

// The signal-badge model carried over from the original storyboard. Kept here
// so nodes can surface cost/security/performance counts uniformly.
export type SignalKind = "cost" | "security" | "performance";
export type Signal = { kind: SignalKind; count: number };

export type TopologyNode = {
  id: string;
  kind: NodeKind;
  label: string;
  /** Secondary line, e.g. "ECS Fargate", "db.m6g.large", "anthropic.com". */
  sublabel?: string;
  /** Group id this node belongs to (see TopologyGroup). Optional → ungrouped. */
  group?: string;
  provider: NodeProvider;
  status?: NodeStatus;
  signals?: Signal[];
  /** True when an LLM refinement pass renamed/regrouped/added this — review me. */
  aiProposed?: boolean;
  /** Free-form provenance / extra attributes; never required by the renderer. */
  meta?: Record<string, unknown>;
};

// Edge kinds are also an OPEN union. The relationship verb, used for labels and
// (optionally) styling.
export type EdgeKind =
  | "routes" // load balancer → service
  | "calls" // service → service (observed request/response)
  | "enqueues" // producer → queue
  | "consumes" // queue → consumer
  | "reads" // service → datastore (read path)
  | "writes" // service → datastore (write path)
  | "depends" // generic dependency
  | (string & {});

// Where an edge came from. This is the most important field for trust: the UI
// styles telemetry edges as solid (observed fact), infra edges as hairline
// (inferred from config), and suggested edges as dashed + AI-marked (review).
export type EdgeSource = "telemetry" | "infra" | "manual" | "suggested";

export type TopologyEdge = {
  id: string;
  from: string;
  to: string;
  kind?: EdgeKind;
  source: EdgeSource;
  /** Short annotation, e.g. "1.3k calls", "219k", "postgres". */
  label?: string;
  meta?: Record<string, unknown>;
};

export type GroupTone = "accent" | "success" | "warning" | "neutral" | "danger";

export type TopologyGroup = {
  id: string;
  label: string;
  tone: GroupTone;
  /**
   * What this group/service is *for* — a one-line intent the LLM assigns. Shown
   * as the service's sublabel in the collapsed (top-level) view.
   */
  intent?: string;
  /**
   * Parent group id, for a nested service hierarchy (e.g. a "ClickHouse cluster"
   * group whose parent is "Telemetry pipeline"). Undefined = a top-level service.
   * A node always belongs to a single LEAF group; the tree is formed by the groups.
   */
  parentId?: string;
  /** True when an LLM refinement pass proposed this grouping — review me. */
  aiProposed?: boolean;
};

export type Topology = {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  groups: TopologyGroup[];
};

// --- small, dependency-free helpers shared across providers/layout/enrich -----

export const emptyTopology = (): Topology => ({ nodes: [], edges: [], groups: [] });

/** Stable id for an edge, so the same logical edge dedupes across providers. */
export const edgeId = (from: string, to: string, kind?: EdgeKind): string =>
  `${from}->${to}${kind ? `:${kind}` : ""}`;

export const nodeById = (t: Topology): Map<string, TopologyNode> =>
  new Map(t.nodes.map((n) => [n.id, n]));

/** Out-degree / in-degree maps, handy for layout and "is this a source" checks. */
export function degrees(t: Topology): {
  out: Map<string, number>;
  in: Map<string, number>;
} {
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  for (const n of t.nodes) {
    out.set(n.id, 0);
    inn.set(n.id, 0);
  }
  for (const e of t.edges) {
    if (out.has(e.from)) out.set(e.from, (out.get(e.from) ?? 0) + 1);
    if (inn.has(e.to)) inn.set(e.to, (inn.get(e.to) ?? 0) + 1);
  }
  return { out, in: inn };
}
