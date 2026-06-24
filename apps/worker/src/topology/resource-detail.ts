// Polymorphic per-resource detail for the service map. A `cloud_resources` row is
// generic (arn / service / type / name / Cloud Control `config`); here we turn it
// into the kind-specific facts a human wants on the card — ECS task counts, the
// RDS instance class, a Lambda's runtime — plus a deep-link into the AWS console.
//
// This is the one place that knows AWS specifics. Everything downstream (the
// topology model, the renderer) stays domain-agnostic: we fold the result into the
// node's generic `meta` bag (`badge`, `facts`, `console`) and the UI just displays
// whatever is there. Add a new resource type by adding a case below, nothing else.

import type { ResourceRow } from "./build.js";

export type ResourceFact = { label: string; value: string };

export type ResourceDetail = {
  /** AWS console deep-link for this exact resource, when we can build one. */
  consoleUrl?: string;
  /** Single headline fact for the card (e.g. "3/3 tasks", "db.t4g.medium"). */
  badge?: string;
  /** Full key/value detail for the inspector. */
  facts: ResourceFact[];
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))
      ? Number(v)
      : undefined;

// Cluster / load-balancer / etc. identifiers often arrive as ARNs; the console
// wants the trailing name. Slash-delimited wins (e.g. `…cluster/name`), else fall
// back to the colon-delimited tail (e.g. a slash-less `arn:…:queue-name`).
const lastSegment = (s: string): string => {
  if (s.includes("/")) return s.slice(s.lastIndexOf("/") + 1);
  if (s.includes(":")) return s.slice(s.lastIndexOf(":") + 1);
  return s;
};

// ECS service ARN: `arn:…:service/<cluster>/<service>` (new long-ARN format).
// Returns [cluster, service] when present.
function ecsClusterService(arn: string): [string | undefined, string | undefined] {
  const rest = arn.split(":").slice(5).join(":"); // e.g. "service/cluster/svc"
  const parts = rest.split("/");
  if (parts[0] === "service" && parts.length >= 3) return [parts[1], parts[2]];
  return [undefined, undefined];
}

/** Best-effort region: the row's column, else parsed from the ARN's 4th field. */
function regionOf(r: ResourceRow): string | undefined {
  if (r.region) return r.region;
  const parts = r.arn.split(":");
  return parts.length > 3 && parts[3] ? parts[3] : undefined;
}

function consoleBase(region: string): string {
  return `https://${region}.console.aws.amazon.com`;
}

/** Resolve the resource detail. Falls back to an empty (no-badge) detail. */
export function resourceDetail(r: ResourceRow): ResourceDetail {
  const builder = BUILDERS[`${r.service}:${r.resourceType ?? ""}`] ?? BUILDERS[r.service];
  const detail = builder?.(r, regionOf(r)) ?? { facts: [] };
  return detail;
}

type Builder = (r: ResourceRow, region?: string) => ResourceDetail;

const BUILDERS: Record<string, Builder> = {
  "ecs:service": (r, region) => {
    const cfg = r.config ?? {};
    const desired = num(cfg.DesiredCount);
    const running = num(cfg.RunningCount);
    const launch = str(cfg.LaunchType);
    // The cluster + service are in the ARN's resource id (`service/<cluster>/<svc>`),
    // so the console link works even before Cloud Control config is fetched.
    const [arnCluster, arnService] = ecsClusterService(r.arn);
    const cfgCluster = str(cfg.Cluster);
    const cluster = cfgCluster ? lastSegment(cfgCluster) : arnCluster;
    const service = str(cfg.ServiceName) ?? arnService ?? r.name ?? undefined;
    const facts: ResourceFact[] = [];
    if (desired != null)
      facts.push({
        label: "Tasks",
        value: running != null ? `${running} running / ${desired} desired` : `${desired} desired`,
      });
    if (launch) facts.push({ label: "Launch type", value: launch });
    if (cluster) facts.push({ label: "Cluster", value: cluster });
    // Headline: running/desired if we have both, else the desired count.
    const badge =
      desired != null
        ? running != null
          ? `${running}/${desired} tasks`
          : `${desired} ${desired === 1 ? "task" : "tasks"}`
        : undefined;
    const consoleUrl =
      region && cluster && service
        ? `${consoleBase(region)}/ecs/v2/clusters/${enc(cluster)}/services/${enc(service)}/health?region=${region}`
        : undefined;
    return { consoleUrl, badge, facts };
  },

  "rds:db": (r, region) => {
    const cfg = r.config ?? {};
    const cls = str(cfg.DBInstanceClass);
    const engine = str(cfg.Engine);
    const multiAz = typeof cfg.MultiAZ === "boolean" ? cfg.MultiAZ : undefined;
    const facts: ResourceFact[] = [];
    if (engine) facts.push({ label: "Engine", value: engine });
    if (cls) facts.push({ label: "Class", value: cls });
    if (multiAz != null) facts.push({ label: "Multi-AZ", value: multiAz ? "yes" : "no" });
    const id = str(cfg.DBInstanceIdentifier) ?? r.name ?? undefined;
    const consoleUrl =
      region && id
        ? `${consoleBase(region)}/rds/home?region=${region}#database:id=${enc(id)};is-cluster=false`
        : undefined;
    return { consoleUrl, badge: cls, facts };
  },

  "rds:cluster": (r, region) => {
    const cfg = r.config ?? {};
    const engine = str(cfg.Engine);
    const id = str(cfg.DBClusterIdentifier) ?? r.name ?? undefined;
    const facts: ResourceFact[] = engine ? [{ label: "Engine", value: engine }] : [];
    const consoleUrl =
      region && id
        ? `${consoleBase(region)}/rds/home?region=${region}#database:id=${enc(id)};is-cluster=true`
        : undefined;
    return { consoleUrl, badge: engine, facts };
  },

  "ec2:instance": (r, region) => {
    const cfg = r.config ?? {};
    const type = str(cfg.InstanceType);
    const az = str(cfg.AvailabilityZone);
    const id = str(cfg.InstanceId) ?? r.name ?? lastSegment(r.arn);
    const facts: ResourceFact[] = [];
    if (type) facts.push({ label: "Instance type", value: type });
    if (az) facts.push({ label: "AZ", value: az });
    const consoleUrl =
      region && id
        ? `${consoleBase(region)}/ec2/home?region=${region}#InstanceDetails:instanceId=${enc(id)}`
        : undefined;
    return { consoleUrl, badge: type, facts };
  },

  "lambda:function": (r, region) => {
    const cfg = r.config ?? {};
    const runtime = str(cfg.Runtime);
    const mem = num(cfg.MemorySize);
    const name = str(cfg.FunctionName) ?? r.name ?? undefined;
    const facts: ResourceFact[] = [];
    if (runtime) facts.push({ label: "Runtime", value: runtime });
    if (mem != null) facts.push({ label: "Memory", value: `${mem} MB` });
    const consoleUrl =
      region && name
        ? `${consoleBase(region)}/lambda/home?region=${region}#/functions/${enc(name)}`
        : undefined;
    return { consoleUrl, badge: runtime, facts };
  },

  "elasticloadbalancing:loadbalancer": (r, region) => {
    const cfg = r.config ?? {};
    const type = str(cfg.Type); // application | network | gateway
    const scheme = str(cfg.Scheme);
    const facts: ResourceFact[] = [];
    if (type) facts.push({ label: "Type", value: type });
    if (scheme) facts.push({ label: "Scheme", value: scheme });
    const name = r.name ?? lastSegment(r.arn);
    const consoleUrl = region
      ? `${consoleBase(region)}/ec2/home?region=${region}#LoadBalancers:search=${enc(name)}`
      : undefined;
    const badge = type ? type.toUpperCase().slice(0, 3) : undefined; // ALB / NET / GAT
    return { consoleUrl, badge, facts };
  },

  "dynamodb:table": (r, region) => {
    const name = str(r.config?.TableName) ?? r.name ?? lastSegment(r.arn);
    const consoleUrl = region
      ? `${consoleBase(region)}/dynamodbv2/home?region=${region}#table?name=${enc(name)}`
      : undefined;
    return { consoleUrl, facts: [] };
  },

  sqs: (r, region) => {
    const name = r.name ?? lastSegment(r.arn);
    const consoleUrl = region
      ? `${consoleBase(region)}/sqs/v3/home?region=${region}#/queues`
      : undefined;
    return {
      consoleUrl,
      badge: name.endsWith("-dlq") || name.endsWith("-dead-letter") ? "DLQ" : undefined,
      facts: [],
    };
  },
};

const enc = encodeURIComponent;
