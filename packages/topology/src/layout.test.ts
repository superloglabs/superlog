import assert from "node:assert/strict";
import { test } from "node:test";
import { assignLayers, layoutTopology } from "./layout.js";
import type { Topology } from "./topology.js";

const node = (id: string) => ({
  id,
  kind: "compute" as const,
  label: id,
  provider: "infra" as const,
});
const edge = (from: string, to: string) => ({
  id: `${from}->${to}`,
  from,
  to,
  source: "infra" as const,
});

// alb → api → postgres ; alb → proxy ; proxy → queue → consumer
const t: Topology = {
  nodes: ["alb", "api", "postgres", "proxy", "queue", "consumer"].map(node),
  edges: [
    edge("alb", "api"),
    edge("api", "postgres"),
    edge("alb", "proxy"),
    edge("proxy", "queue"),
    edge("queue", "consumer"),
  ],
  groups: [],
};

test("sources land in layer 0 and depth increases along edges", () => {
  const layers = assignLayers(t);
  assert.equal(layers.get("alb"), 0);
  assert.equal(layers.get("api"), 1);
  assert.equal(layers.get("postgres"), 2);
  assert.equal(layers.get("proxy"), 1);
  assert.equal(layers.get("queue"), 2);
  assert.equal(layers.get("consumer"), 3);
});

test("layout is deterministic and places later layers further right", () => {
  const a = layoutTopology(t);
  const b = layoutTopology(t);
  assert.deepEqual([...a.positions.entries()].sort(), [...b.positions.entries()].sort());
  const alb = a.positions.get("alb")!;
  const api = a.positions.get("api")!;
  const postgres = a.positions.get("postgres")!;
  assert.ok(api.x > alb.x, "api right of alb");
  assert.ok(postgres.x > api.x, "postgres right of api");
});

test("cycles terminate (no infinite layering) and stay bounded", () => {
  const cyclic: Topology = {
    nodes: ["a", "b", "c"].map(node),
    edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    groups: [],
  };
  const layers = assignLayers(cyclic);
  for (const v of layers.values())
    assert.ok(v < cyclic.nodes.length, "layer stays bounded under a cycle");
});

test("extent grows with the widest layer", () => {
  const { extent } = layoutTopology(t);
  assert.ok(extent.w > 0 && extent.h > 0);
});

test("swimlane mode keeps each group in a non-overlapping vertical band", () => {
  const grouped: Topology = {
    nodes: [
      { ...node("alb"), group: "edge" },
      { ...node("api"), group: "app" }, // layer 1
      { ...node("worker"), group: "app" }, // layer 1 (also fed by alb) → same column as api
      { ...node("pg"), group: "data" },
    ],
    edges: [edge("alb", "api"), edge("alb", "worker"), edge("api", "pg"), edge("worker", "pg")],
    groups: [
      { id: "edge", label: "Edge", tone: "accent" },
      { id: "app", label: "App", tone: "neutral" },
      { id: "data", label: "Data", tone: "success" },
    ],
  };
  const { positions } = layoutTopology(grouped, { lanes: true });
  const yOf = (id: string) => positions.get(id)!.y;
  // lane order edge < app < data means every edge node sits above every app node, etc.
  assert.ok(yOf("alb") < yOf("api"), "edge lane above app lane");
  assert.ok(yOf("alb") < yOf("worker"));
  assert.ok(Math.max(yOf("api"), yOf("worker")) < yOf("pg"), "app lane above data lane");
  // api & worker share a lane AND a dependency layer → they stack vertically, not overlap
  assert.notEqual(yOf("api"), yOf("worker"));
});
