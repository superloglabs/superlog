// Heuristic service map: cluster inventoried resources into logical "services"
// using the strongest available signals (ECS service identity → Service/app tag →
// Role tag → normalized name), bucket each service into a lane, and infer a few
// obvious edges. This is the deterministic layer; an AI pass can refine it later,
// but it already produces a usable map from tags/names/config alone.

export type ServiceMapResource = {
  arn: string;
  service: string; // aws service, e.g. "ec2"
  resourceType: string | null; // e.g. "instance"
  name: string | null;
  tags: Record<string, string> | null;
  config: Record<string, unknown> | null;
};

export type ServiceMapNode = {
  id: string;
  name: string;
  kind: string; // edge | service | worker | database | static | network
  status: "healthy" | "degraded" | "down";
  group: string;
  x: number;
  y: number;
  resourceCount: number;
  badges: { kind: "cost" | "security" | "performance"; count: number }[];
};
export type ServiceMapGroup = {
  id: string;
  name: string;
  tone: "accent" | "success" | "warning" | "neutral";
};
export type ServiceMapEdge = { from: string; to: string };
export type ServiceMap = {
  groups: ServiceMapGroup[];
  nodes: ServiceMapNode[];
  edges: ServiceMapEdge[];
};

// Resource types that are noise on a service map — they belong to a service but
// don't warrant their own node (rules, snapshots, individual log groups, etc.).
const NOISE_TYPES = new Set([
  "ec2:security-group-rule",
  "ec2:snapshot",
  "ec2:volume",
  "ec2:route-table",
  "ec2:subnet",
  "ec2:network-interface",
  "ec2:launch-template",
  "rds:snapshot",
  "elasticloadbalancing:listener",
  "elasticloadbalancing:listener-rule",
  "elasticloadbalancing:targetgroup",
  "logs:log-group",
  "acm:certificate",
]);

// Lanes the services are bucketed into (left→right reads edge→core→data).
const GROUPS: ServiceMapGroup[] = [
  { id: "edge", name: "Edge", tone: "accent" },
  { id: "core", name: "Core services", tone: "neutral" },
  { id: "data", name: "Data plane", tone: "success" },
  { id: "network", name: "Networking", tone: "warning" },
];

function laneFor(awsService: string, resourceType: string | null): string {
  if (awsService === "elasticloadbalancing" || awsService === "cloudfront") return "edge";
  if (
    ["rds", "elasticache", "dynamodb", "s3", "clickhouse"].includes(awsService) ||
    resourceType === "db"
  )
    return "data";
  if (["ec2", "ecs", "lambda", "autoscaling"].includes(awsService)) {
    // EC2 that's really networking infra (NAT, EIP, etc.) → network lane.
    if (awsService === "ec2" && resourceType && resourceType !== "instance") return "network";
    return "core";
  }
  return "network";
}

function kindFor(awsService: string, resourceType: string | null): string {
  if (resourceType === "db" || awsService === "rds") return "database";
  if (awsService === "elasticloadbalancing") return "edge";
  if (awsService === "lambda") return "worker";
  if (awsService === "s3") return "static";
  if (awsService === "ec2" && resourceType !== "instance") return "network";
  return "service";
}

// Strip an `<org>-<env>-` style prefix and trailing instance/AZ/replica suffixes
// so e.g. `superlog-prod-clickhouse-replica-02` collapses to `clickhouse`.
function normalizeName(raw: string): string {
  let s = raw.toLowerCase();
  const env = s.match(/-(prod|production|dev|development|staging|stg|test|qa)-/);
  if (env && env.index !== undefined) s = s.slice(env.index + env[0].length);
  // Strip a trailing AZ/region suffix (e.g. `-us-west-2a`) before tokenizing,
  // since splitting on hyphens would otherwise scatter it into pieces.
  s = s.replace(/-[a-z]{2}-[a-z]+-\d+[a-z]?$/, "");
  const tokens = s.split(/[-/]/).filter(Boolean);
  const drop = /^(\d+|replica|keeper|node|primary|secondary|standby)$/;
  while (tokens.length > 1 && drop.test(tokens[tokens.length - 1] ?? "")) tokens.pop();
  return tokens.join("-") || raw.toLowerCase();
}

/** The logical service a resource belongs to, or null to skip it. */
export function serviceKeyOf(r: ServiceMapResource): string | null {
  const typeKey = `${r.service}:${r.resourceType ?? ""}`;
  if (NOISE_TYPES.has(typeKey)) return null;

  if (r.service === "ecs" && r.resourceType === "service" && r.name) {
    // name is "cluster/service" → use the service segment.
    return normalizeName(r.name.split("/").pop() ?? r.name);
  }
  const tag = r.tags?.Service ?? r.tags?.app ?? r.tags?.component;
  if (tag) return normalizeName(tag);
  // Role tags are conventionally `<component>-<subrole>` (clickhouse-server,
  // clickhouse-keeper) — group on the component so the tiers land together.
  const role = r.tags?.Role;
  if (role) return role.toLowerCase().split(/[-/]/)[0] || normalizeName(role);
  if (r.name) return normalizeName(r.name);
  return null;
}

export function buildServiceMap(resources: ServiceMapResource[]): ServiceMap {
  // Bucket resources by service key.
  const byKey = new Map<string, ServiceMapResource[]>();
  for (const r of resources) {
    const key = serviceKeyOf(r);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  // Each key → a node. Lane/kind come from the dominant resource.
  const nodes: ServiceMapNode[] = [];
  for (const [key, rs] of byKey) {
    const counts = new Map<string, number>();
    for (const r of rs) counts.set(r.service, (counts.get(r.service) ?? 0) + 1);
    const dominant =
      [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? rs[0]?.service ?? "";
    const dType = rs.find((r) => r.service === dominant)?.resourceType ?? null;
    nodes.push({
      id: key,
      name: key,
      kind: kindFor(dominant, dType),
      status: "healthy",
      group: laneFor(dominant, dType),
      x: 0,
      y: 0,
      resourceCount: rs.length,
      badges: [],
    });
  }

  layout(nodes);
  return { groups: GROUPS, nodes, edges: inferEdges(nodes) };
}

// Column per lane, stacked vertically. Stable + readable for a first render.
function layout(nodes: ServiceMapNode[]): void {
  const laneX: Record<string, number> = { edge: 40, core: 360, data: 680, network: 1000 };
  const perLane = new Map<string, number>();
  for (const n of nodes.sort((a, b) => a.name.localeCompare(b.name))) {
    const i = perLane.get(n.group) ?? 0;
    n.x = laneX[n.group] ?? 360;
    n.y = 40 + i * 120;
    perLane.set(n.group, i + 1);
  }
}

// Light, honest edges: every core service points at each data-plane service
// (apps depend on their datastores). Real per-resource edges (from config/SG or
// telemetry) are a later enrichment.
function inferEdges(nodes: ServiceMapNode[]): ServiceMapEdge[] {
  const core = nodes.filter((n) => n.group === "core");
  const data = nodes.filter((n) => n.group === "data");
  const edge = nodes.filter((n) => n.group === "edge");
  const edges: ServiceMapEdge[] = [];
  for (const e of edge) for (const c of core) edges.push({ from: e.id, to: c.id });
  for (const c of core) for (const d of data) edges.push({ from: c.id, to: d.id });
  return edges;
}
