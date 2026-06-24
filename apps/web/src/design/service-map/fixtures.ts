// ---------------------------------------------------------------------------
// Real-data fixtures
//
// A snapshot of Superlog's OWN prod infrastructure (AWS account us-west-2) plus
// the cross-service call graph observed in our OWN dogfood telemetry. Captured
// read-only via `aws` describe calls + ClickHouse SELECTs so the storybook shows
// a real, recognizable map rather than invented boxes. The same provider →
// merge → layout path runs here as it will in the worker, so iterating on these
// fixtures is iterating on the production data contract.
//
// Deterministic edges below = solid facts (load-balancer wiring, queue plumbing,
// and *observed* client spans). Edges the data did NOT surface — e.g. api↔Postgres
// (the API's PG client spans aren't instrumented) — are intentionally LEFT OUT so
// the LLM enrichment pass (enrichment.fixtures.ts) can demonstrate "create links."
// ---------------------------------------------------------------------------

import {
  type AwsInfraSnapshot,
  type ServiceGraph,
  awsInfraProvider,
  mergeTopologies,
  telemetryProvider,
} from "@superlog/topology";

// Internal collector NLB host as it appears in client spans (server.address).
const COLLECTOR_HOST = "superlog-prod-collector-28757fa87820e028.elb.us-west-2.amazonaws.com";

export const awsSnapshot: AwsInfraSnapshot = {
  resources: [
    {
      id: "alb",
      kind: "edge",
      label: "superlog-prod-app",
      sublabel: "ALB · internet-facing",
      service: "elb",
    },
    {
      id: "ecs:api",
      kind: "compute",
      label: "superlog-api",
      sublabel: "ECS Fargate · :4100",
      service: "ecs",
    },
    {
      id: "ecs:proxy",
      kind: "compute",
      label: "superlog-proxy",
      sublabel: "ECS Fargate · :4000",
      service: "ecs",
    },
    {
      id: "ecs:admin-api",
      kind: "compute",
      label: "superlog-admin-api",
      sublabel: "ECS Fargate · :4200",
      service: "ecs",
    },
    {
      id: "ecs:worker",
      kind: "compute",
      label: "superlog-worker",
      sublabel: "ECS Fargate",
      service: "ecs",
    },
    {
      id: "ecs:ingest-consumer",
      kind: "compute",
      label: "superlog-ingest-consumer",
      sublabel: "ECS Fargate",
      service: "ecs",
    },
    {
      id: "ecs:collector",
      kind: "compute",
      label: "superlog-collector",
      sublabel: "ECS Fargate · otelcol",
      service: "ecs",
    },
    {
      id: "web",
      kind: "edge",
      label: "@superlog/web",
      sublabel: "S3 + CloudFront",
      service: "cloudfront",
    },
    {
      id: "sqs:ingest",
      kind: "queue",
      label: "superlog-prod-app-ingest",
      sublabel: "SQS (+ DLQ)",
      service: "sqs",
    },
    {
      id: "rds:postgres",
      kind: "database",
      label: "superlog-prod-postgres",
      sublabel: "RDS · db.m6g.large · Multi-AZ",
      service: "rds",
    },
    {
      id: "clickhouse",
      kind: "database",
      label: "superlog-prod-clickhouse-ha",
      sublabel: "EC2 · 3 replicas + 3 keeper",
      service: "ec2",
    },
  ],
  // Solid, inferable wiring (load balancer targets + queue plumbing + collector write path).
  relationships: [
    { from: "alb", to: "ecs:api", kind: "routes", label: ":4100" },
    { from: "alb", to: "ecs:proxy", kind: "routes", label: ":4000" },
    { from: "alb", to: "ecs:admin-api", kind: "routes", label: ":4200" },
    { from: "ecs:proxy", to: "sqs:ingest", kind: "enqueues" },
    { from: "sqs:ingest", to: "ecs:ingest-consumer", kind: "consumes" },
    { from: "ecs:ingest-consumer", to: "ecs:collector", kind: "writes", label: "forwards OTLP" },
    { from: "ecs:collector", to: "clickhouse", kind: "writes" },
  ],
};

// Observed in our own traces (last 6h, dogfood project). Counts are real.
export const serviceGraph: ServiceGraph = {
  services: [
    { name: "superlog-proxy", spans: 992721 },
    { name: "superlog-ingest-consumer", spans: 343770 },
    { name: "superlog-worker", spans: 131869 },
    { name: "superlog-api", spans: 47427 },
    { name: "@superlog/web", spans: 3895 },
  ],
  edges: [{ from: "@superlog/web", to: "superlog-api", calls: 1373 }],
  // Only deps that resolve to an internal node we model (collector NLB, Postgres).
  // The third-party SaaS deps (Anthropic/GitHub/Slack/…) are intentionally omitted —
  // external integrations aren't part of the system map.
  externalDeps: [
    { from: "superlog-ingest-consumer", target: COLLECTOR_HOST, peerKind: "http", calls: 219511 },
    { from: "superlog-worker", target: "postgresql", peerKind: "db", calls: 13583 },
    { from: "superlog-worker", target: COLLECTOR_HOST, peerKind: "http", calls: 120 },
    { from: "superlog-proxy", target: COLLECTOR_HOST, peerKind: "http", calls: 12 },
  ],
};

// Reconcile telemetry-native ids (svc:/ext:) onto the canonical AWS resource ids
// so a service and its ECS task collapse into one node.
export const aliases: Record<string, string> = {
  "svc:superlog-api": "ecs:api",
  "svc:superlog-proxy": "ecs:proxy",
  "svc:superlog-worker": "ecs:worker",
  "svc:superlog-ingest-consumer": "ecs:ingest-consumer",
  "svc:@superlog/web": "web",
  "ext:postgresql": "rds:postgres",
  [`ext:${COLLECTOR_HOST}`]: "ecs:collector",
};

/** The deterministic, trustworthy unified topology — before any LLM refinement. */
export const rawTopology = mergeTopologies(
  [awsInfraProvider(awsSnapshot), telemetryProvider(serviceGraph)],
  aliases,
);
