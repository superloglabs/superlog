import assert from "node:assert/strict";
import { test } from "node:test";
import { type TopologyEnrichment, applyEnrichment } from "./enrich.js";
import type { Topology } from "./topology.js";

const base: Topology = {
  nodes: [
    { id: "ecs:api", kind: "compute", label: "superlog-api", provider: "merged" },
    { id: "sqs:ingest", kind: "queue", label: "superlog-prod-app-ingest", provider: "infra" },
    { id: "ecs:proxy", kind: "compute", label: "superlog-proxy", provider: "merged" },
  ],
  edges: [
    {
      id: "ecs:proxy->ecs:api",
      from: "ecs:proxy",
      to: "ecs:api",
      source: "telemetry",
      kind: "calls",
    },
  ],
  groups: [],
};

const enrichment: TopologyEnrichment = {
  summary: "Grouped by tier; linked proxy→queue.",
  groups: [{ id: "ingest", label: "Ingest pipeline", tone: "accent" }],
  nodePatches: [
    { id: "ecs:api", label: "API", group: "app" },
    { id: "sqs:ingest", label: "Ingest queue", group: "ingest" },
  ],
  suggestedEdges: [
    { from: "ecs:proxy", to: "sqs:ingest", kind: "enqueues", label: "infers enqueue" },
  ],
};

test("applyEnrichment renames + regroups via nodePatches and flags them aiProposed", () => {
  const out = applyEnrichment(base, enrichment);
  const api = out.nodes.find((n) => n.id === "ecs:api")!;
  assert.equal(api.label, "API");
  assert.equal(api.group, "app");
  assert.equal(api.aiProposed, true);
  assert.ok(out.groups.some((g) => g.id === "ingest" && g.aiProposed));
});

test("suggested links are added with source 'suggested', existing edges untouched", () => {
  const out = applyEnrichment(base, enrichment);
  const suggested = out.edges.find((e) => e.from === "ecs:proxy" && e.to === "sqs:ingest");
  assert.equal(suggested?.source, "suggested");
  // the deterministic telemetry edge is still present and still telemetry-sourced
  const det = out.edges.find((e) => e.from === "ecs:proxy" && e.to === "ecs:api");
  assert.equal(det?.source, "telemetry");
  assert.equal(out.edges.length, base.edges.length + 1);
});

test("toggling a capability off makes that part a no-op", () => {
  const noRename = applyEnrichment(base, enrichment, { rename: false });
  assert.equal(noRename.nodes.find((n) => n.id === "ecs:api")!.label, "superlog-api");
  // regroup still applied
  assert.equal(noRename.nodes.find((n) => n.id === "ecs:api")!.group, "app");

  const noLinks = applyEnrichment(base, enrichment, { suggestLinks: false });
  assert.equal(noLinks.edges.length, base.edges.length);

  const noGroup = applyEnrichment(base, enrichment, { regroup: false });
  assert.equal(noGroup.groups.length, 0);
  assert.equal(noGroup.nodes.find((n) => n.id === "ecs:api")!.group, undefined);
});

test("never duplicates a known pair and never drops a deterministic edge", () => {
  const dupAttempt: TopologyEnrichment = {
    suggestedEdges: [{ from: "ecs:proxy", to: "ecs:api", kind: "depends" }],
  };
  const out = applyEnrichment(base, dupAttempt);
  assert.equal(out.edges.length, base.edges.length, "no duplicate pair added");
  assert.equal(out.edges[0]?.source, "telemetry", "original edge preserved");
});

test("suggested edge to a missing node is skipped", () => {
  const out = applyEnrichment(base, { suggestedEdges: [{ from: "ecs:proxy", to: "ghost" }] });
  assert.equal(out.edges.length, base.edges.length);
});
