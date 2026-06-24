import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AwsInfraSnapshot,
  type ServiceGraph,
  awsInfraProvider,
  mergeTopologies,
  telemetryProvider,
} from "./providers.js";

const infra: AwsInfraSnapshot = {
  resources: [
    { id: "ecs:api", kind: "compute", label: "api", sublabel: "ECS Fargate", service: "ecs" },
    { id: "rds:postgres", kind: "database", label: "postgres", service: "rds" },
    { id: "alb", kind: "edge", label: "app ALB", service: "elb" },
  ],
  relationships: [{ from: "alb", to: "ecs:api", kind: "routes", label: ":4100" }],
};

const graph: ServiceGraph = {
  services: [{ name: "superlog-api", spans: 16795 }],
  edges: [{ from: "@superlog/web", to: "superlog-api", calls: 1373 }],
  externalDeps: [
    { from: "superlog-api", target: "api.anthropic.com", peerKind: "http", calls: 1864 },
    { from: "superlog-api", target: "postgresql", peerKind: "db", calls: 13583 },
  ],
};

test("awsInfraProvider maps resources to infra nodes and inferred edges", () => {
  const t = awsInfraProvider(infra);
  assert.equal(t.nodes.length, 3);
  assert.ok(t.nodes.every((n) => n.provider === "infra"));
  assert.equal(t.edges.length, 1);
  assert.equal(t.edges[0]?.source, "infra");
  assert.equal(t.edges[0]?.kind, "routes");
});

test("telemetryProvider emits observed edges + external dependency nodes", () => {
  const t = telemetryProvider(graph);
  // web (auto from edge endpoint is NOT created — only declared services), api, anthropic, postgresql
  const labels = t.nodes.map((n) => n.label).sort();
  // exact membership (.some(===)) not .includes — the latter trips CodeQL's
  // URL-substring rule on the host-looking label, a false positive here.
  assert.ok(labels.some((l) => l === "superlog-api"));
  assert.ok(labels.some((l) => l === "api.anthropic.com"));
  assert.ok(labels.some((l) => l === "postgresql"));
  // the call edge is telemetry-sourced and labelled
  const call = t.edges.find((e) => e.kind === "calls" && e.label?.includes("calls"));
  assert.ok(call, "expected a labelled call edge");
  assert.equal(call?.source, "telemetry");
  // a db peer becomes a database node read by the service
  const dbNode = t.nodes.find((n) => n.label === "postgresql");
  assert.equal(dbNode?.kind, "database");
  const readEdge = t.edges.find((e) => e.kind === "reads");
  assert.equal(readEdge?.source, "telemetry");
});

test("mergeTopologies reconciles an OTLP service with its AWS resource via aliases", () => {
  const aws = awsInfraProvider(infra);
  const tel = telemetryProvider(graph);
  // telemetry ids are "svc:<name>" / "ext:<name>"; alias superlog-api → the ECS resource,
  // and the db peer → the same RDS resource infra knows about.
  const merged = mergeTopologies([aws, tel], {
    "svc:superlog-api": "ecs:api",
    "ext:postgresql": "rds:postgres",
  });

  // superlog-api and ecs:api collapse into ONE node, now provider "merged".
  const api = merged.nodes.filter((n) => n.id === "ecs:api");
  assert.equal(api.length, 1, "api node must be deduped");
  assert.equal(api[0]?.provider, "merged");
  assert.equal(api[0]?.label, "api"); // infra label wins (higher precedence)

  // postgres telemetry peer folded into the RDS node — no stray ext:postgresql.
  assert.ok(!merged.nodes.some((n) => n.id === "ext:postgresql"));
  assert.ok(merged.nodes.some((n) => n.id === "rds:postgres"));

  // the observed web→api call edge now points at the canonical api id.
  const webCall = merged.edges.find((e) => e.to === "ecs:api" && e.source === "telemetry");
  assert.ok(webCall, "web→api telemetry edge survives canonicalization");

  // anthropic stays an external node (no alias).
  assert.ok(merged.nodes.some((n) => n.label === "api.anthropic.com"));
});

test("merge keeps the higher-precedence edge source for the same pair", () => {
  const a = { nodes: [n("x"), n("y")], edges: [e("x", "y", "infra", "routes")], groups: [] };
  const b = { nodes: [n("x"), n("y")], edges: [e("x", "y", "telemetry", "calls")], groups: [] };
  const merged = mergeTopologies([a, b]);
  const xy = merged.edges.filter((edge) => edge.from === "x" && edge.to === "y");
  assert.equal(xy.length, 1, "one edge per pair");
  assert.equal(xy[0]?.source, "telemetry", "observed beats inferred");
});

// tiny builders
function n(id: string) {
  return { id, kind: "compute" as const, label: id, provider: "infra" as const };
}
function e(from: string, to: string, source: "infra" | "telemetry", kind: string) {
  return { id: `${from}->${to}:${kind}`, from, to, source, kind };
}
