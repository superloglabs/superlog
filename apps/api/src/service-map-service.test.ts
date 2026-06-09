import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type ServiceMapResource, buildServiceMap, serviceKeyOf } from "./service-map-service.js";

const r = (over: Partial<ServiceMapResource>): ServiceMapResource => ({
  arn: "arn:aws:x",
  service: "ec2",
  resourceType: "instance",
  name: null,
  tags: null,
  config: null,
  ...over,
});

test("serviceKeyOf collapses instance/replica/az suffixes and env prefixes", () => {
  assert.equal(serviceKeyOf(r({ name: "superlog-prod-clickhouse-replica-02" })), "clickhouse");
  assert.equal(serviceKeyOf(r({ name: "superlog-prod-clickhouse-keeper-01" })), "clickhouse");
  assert.equal(serviceKeyOf(r({ name: "superlog-prod-nat-us-west-2a" })), "nat");
  assert.equal(serviceKeyOf(r({ name: "superlog-prod-api" })), "api");
});

test("serviceKeyOf prefers ECS service name, then Service/Role tags", () => {
  assert.equal(
    serviceKeyOf(
      r({
        service: "ecs",
        resourceType: "service",
        name: "superlog-prod-app/superlog-prod-worker",
      }),
    ),
    "worker",
  );
  assert.equal(serviceKeyOf(r({ name: "anything", tags: { Service: "checkout" } })), "checkout");
  // Role tiers collapse to the component, so server + keeper group together.
  assert.equal(serviceKeyOf(r({ name: "i-1", tags: { Role: "clickhouse-server" } })), "clickhouse");
  assert.equal(serviceKeyOf(r({ name: "i-2", tags: { Role: "clickhouse-keeper" } })), "clickhouse");
});

test("serviceKeyOf skips noise resource types", () => {
  assert.equal(serviceKeyOf(r({ service: "ec2", resourceType: "security-group-rule" })), null);
  assert.equal(serviceKeyOf(r({ service: "rds", resourceType: "snapshot" })), null);
});

test("buildServiceMap groups resources into lanes with edges", () => {
  const map = buildServiceMap([
    r({ service: "ecs", resourceType: "service", name: "c/superlog-prod-api" }),
    r({ service: "ecs", resourceType: "service", name: "c/superlog-prod-worker" }),
    r({ service: "rds", resourceType: "db", name: "superlog-prod-postgres" }),
    r({
      service: "elasticloadbalancing",
      resourceType: "loadbalancer",
      name: "app/superlog-prod-app/x",
    }),
    r({ service: "ec2", resourceType: "security-group-rule" }), // skipped
  ]);

  // 4 nodes (api, worker, postgres, the ELB); the security-group-rule is skipped.
  assert.equal(map.nodes.length, 4);
  assert.ok(map.nodes.find((n) => n.id === "api" && n.group === "core"));
  assert.ok(map.nodes.find((n) => n.id === "worker" && n.group === "core"));
  assert.ok(map.nodes.find((n) => n.id === "postgres" && n.group === "data"));
  assert.equal(map.nodes.filter((n) => n.group === "edge").length, 1);
  // core → data edge exists (api → postgres)
  assert.ok(map.edges.some((e) => e.from === "api" && e.to === "postgres"));
  // every node has a position
  assert.ok(map.nodes.every((n) => typeof n.x === "number" && typeof n.y === "number"));
});
