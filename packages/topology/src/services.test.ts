import assert from "node:assert/strict";
import { test } from "node:test";
import { groupPath, isLeafGroup, serviceNodeId, viewTopology } from "./services.js";
import type { Topology } from "./topology.js";

// backend{api} ; telemetry{collector} > clickhouse{replica1, keeper1}
const t: Topology = {
  nodes: [
    { id: "api", kind: "compute", label: "API", provider: "merged", group: "backend" },
    { id: "collector", kind: "compute", label: "Collector", provider: "infra", group: "telemetry" },
    { id: "replica1", kind: "compute", label: "Replica 1", provider: "infra", group: "clickhouse" },
    { id: "keeper1", kind: "compute", label: "Keeper 1", provider: "infra", group: "clickhouse" },
  ],
  edges: [
    { id: "api->collector", from: "api", to: "collector", source: "telemetry", kind: "calls" },
    {
      id: "collector->replica1",
      from: "collector",
      to: "replica1",
      source: "infra",
      kind: "writes",
    },
    { id: "replica1->keeper1", from: "replica1", to: "keeper1", source: "infra", kind: "depends" },
  ],
  groups: [
    { id: "backend", label: "API & backend", tone: "neutral", intent: "Serves the API" },
    { id: "telemetry", label: "Telemetry pipeline", tone: "warning", intent: "Ingests telemetry" },
    {
      id: "clickhouse",
      label: "ClickHouse cluster",
      tone: "success",
      intent: "Analytics store",
      parentId: "telemetry",
    },
  ],
};

test("root view shows top-level services with whole-subtree member counts", () => {
  const v = viewTopology(t, null);
  const ids = v.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, [serviceNodeId("backend"), serviceNodeId("telemetry")]);
  const tel = v.nodes.find((n) => n.id === serviceNodeId("telemetry"))!;
  assert.equal(tel.meta?.memberCount, 3); // collector + replica1 + keeper1 (whole subtree)
  assert.equal(tel.meta?.hasChildren, true);
  // the actual resources inside, so the card can list them (not just a count)
  const members = tel.meta?.members as { id: string; label: string }[];
  assert.deepEqual(
    members.map((m) => m.id).sort(),
    ["collector", "keeper1", "replica1"],
  );
  // backend → telemetry edge (api→collector); clickhouse-internal edges hidden at root
  assert.equal(v.edges.length, 1);
  assert.equal(v.edges[0]?.from, serviceNodeId("backend"));
  assert.equal(v.edges[0]?.to, serviceNodeId("telemetry"));
});

test("drilling a parent shows nested sub-service + direct resources + boundary stub", () => {
  const v = viewTopology(t, "telemetry");
  const ids = v.nodes.map((n) => n.id).sort();
  assert.ok(ids.includes(serviceNodeId("clickhouse")));
  assert.ok(ids.includes("collector"));
  assert.ok(ids.includes("boundary:backend"));
  const ch = v.nodes.find((n) => n.id === serviceNodeId("clickhouse"))!;
  assert.equal(ch.meta?.memberCount, 2);
  // Internal links are kept (collector → clickhouse); so is the inbound boundary
  // edge. The renderer reroutes the boundary edge to the frame, not the model.
  assert.ok(v.edges.some((e) => e.from === "collector" && e.to === serviceNodeId("clickhouse")));
  assert.ok(v.edges.some((e) => e.from === "boundary:backend" && e.to === "collector"));
});

test("drilling a leaf group shows its resources + a boundary to outside services", () => {
  const v = viewTopology(t, "clickhouse");
  const ids = v.nodes.map((n) => n.id).sort();
  assert.ok(ids.includes("replica1") && ids.includes("keeper1"));
  assert.ok(ids.includes("boundary:telemetry"));
  assert.ok(v.edges.some((e) => e.from === "replica1" && e.to === "keeper1"));
  assert.ok(isLeafGroup(t, "clickhouse"));
  assert.ok(!isLeafGroup(t, "telemetry"));
});

test("drilling drops edges between two outside neighbours (no orphan stub)", () => {
  const g: Topology = {
    nodes: [
      { id: "x1", kind: "compute", label: "X1", provider: "infra", group: "X" },
      { id: "a1", kind: "compute", label: "A1", provider: "infra", group: "A" },
      { id: "b1", kind: "compute", label: "B1", provider: "infra", group: "B" },
    ],
    edges: [
      { id: "x1->a1", from: "x1", to: "a1", source: "infra", kind: "calls" }, // X → A
      { id: "a1->b1", from: "a1", to: "b1", source: "infra", kind: "calls" }, // A → B (both outside X)
    ],
    groups: [
      { id: "X", label: "X", tone: "neutral" },
      { id: "A", label: "A", tone: "neutral" },
      { id: "B", label: "B", tone: "neutral" },
    ],
  };
  const v = viewTopology(g, "X");
  const ids = v.nodes.map((n) => n.id);
  assert.ok(ids.includes("x1") && ids.includes("boundary:A"));
  assert.ok(!ids.includes("boundary:B")); // B never materialises — only A touches X
  assert.ok(v.edges.some((e) => e.from === "x1" && e.to === "boundary:A"));
  assert.ok(!v.edges.some((e) => e.from.startsWith("boundary:") && e.to.startsWith("boundary:")));
});

test("groupPath builds the breadcrumb chain root→focus", () => {
  assert.deepEqual(groupPath(t, "clickhouse"), [
    { id: "telemetry", label: "Telemetry pipeline" },
    { id: "clickhouse", label: "ClickHouse cluster" },
  ]);
  assert.deepEqual(groupPath(t, null), []);
});
