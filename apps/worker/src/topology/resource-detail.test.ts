import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResourceRow } from "./build.js";
import { resourceDetail } from "./resource-detail.js";

const row = (over: Partial<ResourceRow>): ResourceRow => ({
  arn: "arn:aws:ecs:us-west-2:121638211609:service/superlog-prod/api",
  service: "ecs",
  resourceType: "service",
  name: "api",
  region: "us-west-2",
  accountId: "121638211609",
  config: null,
  ...over,
});

test("ECS service surfaces running/desired task counts + a console link", () => {
  const d = resourceDetail(
    row({
      config: { ServiceName: "api", Cluster: "superlog-prod", DesiredCount: 3, RunningCount: 3, LaunchType: "FARGATE" },
    }),
  );
  assert.equal(d.badge, "3/3 tasks");
  assert.ok(d.facts.some((f) => f.label === "Tasks" && f.value === "3 running / 3 desired"));
  assert.ok(d.facts.some((f) => f.label === "Launch type" && f.value === "FARGATE"));
  assert.ok(d.consoleUrl?.includes("/ecs/v2/clusters/superlog-prod/services/api/"));
  assert.ok(d.consoleUrl?.includes("us-west-2.console.aws.amazon.com"));
});

test("ECS with only desired count degrades to '<n> tasks'", () => {
  const d = resourceDetail(row({ config: { ServiceName: "api", Cluster: "c", DesiredCount: 1 } }));
  assert.equal(d.badge, "1 task");
});

test("RDS instance surfaces class + engine and a database deep-link", () => {
  const d = resourceDetail(
    row({
      arn: "arn:aws:rds:us-west-2:121638211609:db:superlog-prod-postgres",
      service: "rds",
      resourceType: "db",
      name: "superlog-prod-postgres",
      config: { DBInstanceIdentifier: "superlog-prod-postgres", DBInstanceClass: "db.t4g.medium", Engine: "postgres", MultiAZ: true },
    }),
  );
  assert.equal(d.badge, "db.t4g.medium");
  assert.ok(d.facts.some((f) => f.label === "Multi-AZ" && f.value === "yes"));
  assert.ok(d.consoleUrl?.includes("#database:id=superlog-prod-postgres"));
});

test("region falls back to the ARN when the column is null", () => {
  const d = resourceDetail(row({ region: null, config: { ServiceName: "api", Cluster: "c", DesiredCount: 2 } }));
  assert.ok(d.consoleUrl?.includes("us-west-2"));
});

test("ECS console link works from the ARN alone (no config yet, no task badge)", () => {
  const d = resourceDetail(
    row({
      arn: "arn:aws:ecs:us-west-2:121638211609:service/superlog-prod-app/superlog-prod-api",
      name: "superlog-prod-api",
      config: null,
    }),
  );
  assert.equal(d.badge, undefined); // no config → no task count
  assert.ok(d.consoleUrl?.includes("/clusters/superlog-prod-app/services/superlog-prod-api/"));
});

test("unknown / un-enriched resource yields an empty detail, no throw", () => {
  const d = resourceDetail(row({ service: "kms", resourceType: "key", config: null }));
  assert.deepEqual(d.facts, []);
  assert.equal(d.badge, undefined);
});
