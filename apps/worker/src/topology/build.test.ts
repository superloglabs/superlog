import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServiceGraph } from "@superlog/topology";
import {
  type ResourceRow,
  assembleTopology,
  buildProjectTopology,
  isMappableResource,
  resourceId,
  resourcesToSnapshot,
} from "./build.js";

const rows: ResourceRow[] = [
  {
    arn: "arn:aws:ecs:us-west-2:1:service/superlog-prod-app/superlog-prod-api",
    service: "ecs",
    resourceType: "service",
    name: "superlog-prod-api",
    region: "us-west-2",
  },
  {
    arn: "arn:aws:ecs:us-west-2:1:service/superlog-prod-app/superlog-prod-worker",
    service: "ecs",
    resourceType: "service",
    name: "superlog-prod-worker",
    region: "us-west-2",
  },
  {
    arn: "arn:aws:rds:us-west-2:1:db:superlog-prod-postgres",
    service: "rds",
    resourceType: "db",
    name: "superlog-prod-postgres",
    region: "us-west-2",
  },
  {
    arn: "arn:aws:sqs:us-west-2:1:superlog-prod-app-ingest",
    service: "sqs",
    resourceType: null,
    name: "superlog-prod-app-ingest",
    region: "us-west-2",
  },
];

const graph: ServiceGraph = {
  services: [
    { name: "superlog-api", spans: 100 },
    { name: "superlog-worker", spans: 50 },
  ],
  edges: [{ from: "superlog-api", to: "superlog-worker", calls: 10 }],
  externalDeps: [
    { from: "superlog-worker", target: "postgresql", peerKind: "db", calls: 20 },
    { from: "superlog-worker", target: "api.anthropic.com", peerKind: "http", calls: 5 },
  ],
};

test("resourcesToSnapshot maps services to node kinds", () => {
  const snap = resourcesToSnapshot(rows);
  const kindOf = (id: string) => snap.resources.find((r) => r.id === id)?.kind;
  assert.equal(kindOf(resourceId(rows[0]!)), "compute"); // ecs
  assert.equal(kindOf(resourceId(rows[2]!)), "database"); // rds
  assert.equal(kindOf(resourceId(rows[3]!)), "queue"); // sqs
  assert.equal(snap.relationships.length, 0);
});

test("assembleTopology reconciles telemetry service.name onto its ECS resource", () => {
  const t = assembleTopology(rows, graph);
  // "superlog-api" tokens ⊆ "superlog-prod-api" → collapsed onto the ECS node, not a stray svc: node
  assert.ok(!t.nodes.some((n) => n.id === "svc:superlog-api"));
  const apiNode = t.nodes.find((n) => n.id === resourceId(rows[0]!));
  assert.ok(apiNode, "api ECS node present");
  assert.equal(apiNode?.provider, "merged");
  // the observed api→worker edge now connects the two ECS resource ids
  assert.ok(
    t.edges.some(
      (e) =>
        e.from === resourceId(rows[0]!) &&
        e.to === resourceId(rows[1]!) &&
        e.source === "telemetry",
    ),
  );
});

test("assembleTopology keeps the db peer (folded onto RDS) and drops unmatched SaaS", () => {
  const t = assembleTopology(rows, graph);
  // postgresql db peer reconciles onto the RDS resource
  assert.ok(!t.nodes.some((n) => n.label === "postgresql"));
  assert.ok(
    t.edges.some((e) => e.to === resourceId(rows[2]!)),
    "worker→postgres edge folded onto RDS",
  );
  // anthropic http SaaS is dropped — not part of the system map
  assert.ok(!t.nodes.some((n) => n.id === "ext:api.anthropic.com"));
});

test("an http peer is NOT folded onto a resource just because a leading label matches", () => {
  // "api.resend.com" must not collapse onto the "superlog-prod-api" service.
  const g: ServiceGraph = {
    services: [{ name: "superlog-api", spans: 10 }],
    edges: [],
    externalDeps: [{ from: "superlog-api", target: "api.resend.com", peerKind: "http", calls: 3 }],
  };
  const t = assembleTopology(rows, g);
  assert.ok(!t.nodes.some((n) => n.label.includes("resend")), "resend dropped, not folded");
  assert.ok(
    !t.edges.some(
      (e) => e.to === resourceId(rows[0]!) && e.label === undefined && e.source === "telemetry",
    ),
  );
});

test("isMappableResource keeps system building-blocks and drops plumbing", () => {
  const keep = (service: string, resourceType: string | null): ResourceRow => ({
    arn: `arn:aws:${service}:r:1:x`,
    service,
    resourceType,
    name: null,
    region: null,
  });
  assert.ok(isMappableResource(keep("ecs", "service")));
  assert.ok(isMappableResource(keep("rds", "db")));
  assert.ok(isMappableResource(keep("ec2", "instance")));
  assert.ok(isMappableResource(keep("elasticloadbalancing", "loadbalancer")));
  assert.ok(isMappableResource(keep("sqs", null)));
  // plumbing → dropped
  assert.ok(!isMappableResource(keep("ec2", "security-group-rule")));
  assert.ok(!isMappableResource(keep("ec2", "snapshot")));
  assert.ok(!isMappableResource(keep("secretsmanager", "secret")));
  assert.ok(!isMappableResource(keep("ecs", "task-definition")));
  assert.ok(!isMappableResource(keep("elasticloadbalancing", "targetgroup")));
  assert.ok(!isMappableResource(keep("logs", "log-group")));
});

test("assembleTopology filters plumbing out of the node set", () => {
  const noisy: ResourceRow[] = [
    ...rows,
    {
      arn: "arn:aws:ec2:us-west-2:1:security-group-rule/sgr-1",
      service: "ec2",
      resourceType: "security-group-rule",
      name: null,
      region: "us-west-2",
    },
    {
      arn: "arn:aws:secretsmanager:us-west-2:1:secret:foo",
      service: "secretsmanager",
      resourceType: "secret",
      name: "foo",
      region: "us-west-2",
    },
  ];
  const t = assembleTopology(noisy, { services: [], edges: [], externalDeps: [] });
  assert.ok(!t.nodes.some((n) => n.id.includes("security-group-rule")));
  assert.ok(!t.nodes.some((n) => n.id.includes("secret")));
});

test("buildProjectTopology wires the readers", async () => {
  const t = await buildProjectTopology(
    { listResources: async () => rows, serviceGraph: async () => graph },
    "p1",
  );
  assert.ok(t.nodes.length >= rows.length);
});
