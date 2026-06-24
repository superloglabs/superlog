// Build a deterministic project topology from live data: the AWS resource
// inventory (Postgres `cloud_resources`) for nodes, and the observed
// cross-service call graph (ClickHouse `otel_traces`) for edges. Pure assembly
// lives here (testable with injected rows); IO is behind the `TopologyReaders`
// port. The LLM grouping pass runs separately (enrich.ts).

import {
  type AwsInfraSnapshot,
  type AwsResource,
  type NodeKind,
  type ServiceGraph,
  type Topology,
  awsInfraProvider,
  mergeTopologies,
  telemetryProvider,
} from "@superlog/topology";
import { resourceDetail } from "./resource-detail.js";

/** The columns we read from `cloud_resources`. */
export type ResourceRow = {
  arn: string;
  service: string;
  resourceType: string | null;
  name: string | null;
  region: string | null;
  accountId?: string | null;
  /** Cloud Control configuration (best-effort; null for types we don't enrich). */
  config?: Record<string, unknown> | null;
};

export type TopologyReaders = {
  /** Active (non-removed) resources for the project. */
  listResources: (projectId: string) => Promise<ResourceRow[]>;
  /** Observed service call-graph + outbound peers from telemetry. */
  serviceGraph: (projectId: string) => Promise<ServiceGraph>;
};

// AWS service short-name → node kind. Unknown services fall back to "compute".
const SERVICE_KIND: Record<string, NodeKind> = {
  ecs: "compute",
  lambda: "compute",
  ec2: "compute",
  rds: "database",
  dynamodb: "database",
  elasticache: "cache",
  sqs: "queue",
  sns: "queue",
  kinesis: "queue",
  s3: "storage",
  elasticloadbalancing: "edge",
  cloudfront: "edge",
  apigateway: "edge",
};

// Which (service, resourceType) pairs are worth putting on a system map. The raw
// tag inventory is ~90% plumbing — security-group rules, secrets, snapshots, task
// definitions, listeners, subnets, alarms — which would bury the few resources a
// human cares about. We keep the building blocks of a running system and drop the
// rest. `"all"` keeps every type for that service.
const MAPPABLE: Record<string, "all" | Set<string>> = {
  ecs: new Set(["service"]),
  rds: new Set(["db", "cluster"]),
  ec2: new Set(["instance"]),
  elasticloadbalancing: new Set(["loadbalancer"]),
  lambda: new Set(["function"]),
  dynamodb: new Set(["table"]),
  elasticache: new Set(["cluster", "replicationgroup"]),
  sqs: "all",
  cloudfront: "all",
  // S3 deliberately omitted: our buckets (tfstate, alb-logs, backups, source-maps,
  // cfn-templates) are all infra plumbing, never app-meaningful nodes. Re-add a
  // curated subset if real app buckets show up.
};

export function isMappableResource(r: ResourceRow): boolean {
  const allow = MAPPABLE[r.service];
  if (!allow) return false;
  if (allow === "all") return true;
  return r.resourceType ? allow.has(r.resourceType) : false;
}

const lastArnSegment = (arn: string): string => {
  const tail = arn.split(":").pop() ?? arn;
  return tail.split("/").pop() ?? tail;
};

// Short, stable, human-ish node id — NOT the full ARN. The LLM has to echo these
// back in its nodePatches, and it can't reliably reproduce a 90-char ARN, so a
// full-ARN id silently breaks the whole enrichment. The ARN is preserved in meta.
// Region-qualified so the same `service:name` in two regions (a project may have
// several connections) can't collapse into one node; the suffix stays short enough
// for the LLM to echo. Single-region inventories just get a stable `:region` tail.
export const resourceId = (r: ResourceRow): string =>
  `${r.service}:${r.name ?? lastArnSegment(r.arn)}${r.region ? `@${r.region}` : ""}`;
const resourceLabel = (r: ResourceRow): string => r.name ?? (lastArnSegment(r.arn) || r.service);

export function resourcesToSnapshot(rows: ResourceRow[]): AwsInfraSnapshot {
  const resources: AwsResource[] = rows.map((r) => {
    // Polymorphic per-kind detail: console deep-link + headline badge + facts,
    // folded into the node's generic meta so the renderer stays AWS-agnostic.
    const detail = resourceDetail(r);
    return {
      id: resourceId(r),
      kind: SERVICE_KIND[r.service] ?? "compute",
      label: resourceLabel(r),
      sublabel: r.resourceType ? `${r.service} · ${r.resourceType}` : r.service,
      arn: r.arn,
      service: r.service,
      meta: {
        region: r.region ?? undefined,
        accountId: r.accountId ?? undefined,
        resourceType: r.resourceType ?? undefined,
        console: detail.consoleUrl,
        badge: detail.badge,
        facts: detail.facts.length ? detail.facts : undefined,
      },
    };
  });
  // No reliable relationships come from tag-based inventory alone, so infra edges
  // are left to telemetry (observed) + the LLM's suggested links.
  return { resources, relationships: [] };
}

// --- reconciliation: telemetry service.name / peer host ↔ inventory resource ---

const tokenize = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );

const isSubset = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size === 0) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
};

/**
 * Match a telemetry name (service.name or a peer host's leading label) to the
 * inventory resource it most likely *is*. Heuristic: the name's tokens must be a
 * subset of the resource's tokens; ties broken toward the most specific (fewest
 * extra tokens) resource.
 */
function matchResource(name: string, rows: ResourceRow[]): string | null {
  const want = tokenize(name);
  if (want.size === 0) return null;
  let best: { id: string; extra: number } | null = null;
  for (const r of rows) {
    const have = tokenize(`${r.name ?? ""} ${r.arn}`);
    if (!isSubset(want, have)) continue;
    const extra = have.size - want.size;
    if (!best || extra < best.extra) best = { id: resourceId(r), extra };
  }
  return best?.id ?? null;
}

/**
 * Fold a telemetry peer HOST onto an inventory resource only when the resource's
 * NAME tokens all appear in the host — e.g. internal NLB host
 * `superlog-prod-collector-xyz.elb…` contains every token of `superlog-prod-collector`.
 * This deliberately does NOT match on a single leading label, so `api.resend.com`
 * does not get folded onto our `superlog-prod-api` service. Requires ≥2 name tokens
 * to avoid weak matches.
 */
function matchHostToResource(host: string, rows: ResourceRow[]): string | null {
  const hostTokens = tokenize(host);
  let best: { id: string; score: number } | null = null;
  for (const r of rows) {
    const nameTokens = tokenize(r.name ?? "");
    if (nameTokens.size < 2) continue;
    if (![...nameTokens].every((t) => hostTokens.has(t))) continue;
    if (!best || nameTokens.size > best.score) best = { id: resourceId(r), score: nameTokens.size };
  }
  return best?.id ?? null;
}

// `db.system` values are generic engine names, not resource names, so they don't
// token-match. Map the engine → AWS service and fold onto that resource when the
// project has exactly one of them.
const DB_SYSTEM_SERVICE: Record<string, string> = {
  postgresql: "rds",
  postgres: "rds",
  mysql: "rds",
  mariadb: "rds",
  aurora: "rds",
  dynamodb: "dynamodb",
  redis: "elasticache",
  memcached: "elasticache",
};

function matchDbEngine(engine: string, rows: ResourceRow[]): string | null {
  const service = DB_SYSTEM_SERVICE[engine.toLowerCase()];
  if (!service) return null;
  const candidates = rows.filter((r) => r.service === service);
  return candidates.length === 1 ? resourceId(candidates[0]!) : null;
}

/**
 * Assemble nodes (inventory) + edges (telemetry) into one topology. External
 * HTTP peers (third-party SaaS) are dropped unless they resolve to a known
 * resource — only internal infra (datastores, queues, our own hosts) stays.
 */
export function assembleTopology(allRows: ResourceRow[], graph: ServiceGraph): Topology {
  // Drop infrastructure plumbing before anything else — both the nodes we draw
  // and the telemetry↔resource reconciliation work off the curated set.
  const rows = allRows.filter(isMappableResource);
  const snapshot = resourcesToSnapshot(rows);

  const aliases: Record<string, string> = {};
  for (const svc of graph.services) {
    const id = matchResource(svc.name, rows);
    if (id) aliases[`svc:${svc.name}`] = id;
  }

  // Keep db/messaging peers (infra) and any http peer that maps to a resource;
  // drop unmatched http SaaS so the map stays about the customer's own system.
  const keptDeps = graph.externalDeps.filter((dep) => {
    if (dep.peerKind === "db" || dep.peerKind === "messaging") return true;
    const id = matchHostToResource(dep.target, rows);
    if (id) {
      aliases[`ext:${dep.target}`] = id;
      return true;
    }
    return false; // unmatched third-party SaaS → dropped
  });
  // db/messaging peers may still alias onto a resource (e.g. "postgresql" → RDS).
  for (const dep of keptDeps) {
    if (aliases[`ext:${dep.target}`]) continue;
    let id = matchHostToResource(dep.target, rows);
    if (!id && dep.peerKind === "db") id = matchDbEngine(dep.target, rows);
    if (id) aliases[`ext:${dep.target}`] = id;
  }

  const filteredGraph: ServiceGraph = { ...graph, externalDeps: keptDeps };
  const merged = mergeTopologies(
    [awsInfraProvider(snapshot), telemetryProvider(filteredGraph)],
    aliases,
  );

  // External integrations (third-party SaaS) don't belong on a system map — drop
  // any external-kind node that slipped through, and edges touching it.
  const keep = merged.nodes.filter((n) => n.kind !== "external");
  const keepIds = new Set(keep.map((n) => n.id));
  return {
    nodes: keep,
    edges: merged.edges.filter((e) => keepIds.has(e.from) && keepIds.has(e.to)),
    groups: merged.groups,
  };
}

export async function buildProjectTopology(
  readers: TopologyReaders,
  projectId: string,
): Promise<Topology> {
  const [rows, graph] = await Promise.all([
    readers.listResources(projectId),
    readers.serviceGraph(projectId),
  ]);
  return assembleTopology(rows, graph);
}
