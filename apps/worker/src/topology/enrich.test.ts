import assert from "node:assert/strict";
import { test } from "node:test";
import type { Topology } from "@superlog/topology";
import {
  type EnrichLLMClient,
  enrichTopologyWithClient,
  parseEnrichmentToolInput,
} from "./enrich.js";

const known = new Set(["a", "b", "db"]);

test("parseEnrichmentToolInput keeps valid groups/patches/edges, drops unknown refs", () => {
  const out = parseEnrichmentToolInput(
    {
      summary: "grouped",
      groups: [
        { id: "app", label: "App", intent: "serves traffic", tone: "neutral" },
        { id: "bad" }, // missing label → dropped
      ],
      nodePatches: [
        { id: "a", label: "A", group: "app" },
        { id: "ghost", group: "app" }, // unknown node → dropped
        { id: "b", group: "missing" }, // unknown group → dropped
      ],
      suggestedEdges: [
        { from: "a", to: "db", kind: "reads" },
        { from: "a", to: "ghost" }, // unknown endpoint → dropped
      ],
    },
    known,
  )!;
  assert.equal(out.groups?.length, 1);
  assert.equal(out.groups?.[0]?.id, "app");
  assert.deepEqual(out.nodePatches, [{ id: "a", label: "A", group: "app" }]);
  assert.equal(out.suggestedEdges?.length, 1);
  assert.equal(out.suggestedEdges?.[0]?.from, "a");
});

test("parseEnrichmentToolInput breaks parent cycles so no group is orphaned", () => {
  // A→B→A: both parents would be valid per-edge, but the cycle would hide both
  // groups from every rendered level. The parser must drop the cyclic links.
  const out = parseEnrichmentToolInput(
    {
      groups: [
        { id: "a", label: "A", tone: "neutral", parent: "b" },
        { id: "b", label: "B", tone: "neutral", parent: "a" },
        { id: "c", label: "C", tone: "neutral", parent: "a" }, // acyclic child of A
      ],
      nodePatches: [],
    },
    known,
  )!;
  const byId = new Map(out.groups?.map((g) => [g.id, g]));
  assert.equal(byId.get("a")?.parent, undefined); // cycle cut
  assert.equal(byId.get("b")?.parent, undefined); // cycle cut
  assert.equal(byId.get("c")?.parent, "a"); // healthy link preserved
});

test("parseEnrichmentToolInput defaults an invalid tone to neutral and rejects empty", () => {
  const out = parseEnrichmentToolInput(
    { groups: [{ id: "g", label: "G", tone: "rainbow" }], nodePatches: [] },
    known,
  )!;
  assert.equal(out.groups?.[0]?.tone, "neutral");
  assert.equal(parseEnrichmentToolInput({ groups: [] }, known), null);
  assert.equal(parseEnrichmentToolInput("nope", known), null);
});

test("enrichTopologyWithClient forces the tool and parses its input", async () => {
  const topology: Topology = {
    nodes: [
      { id: "a", kind: "compute", label: "svc-a", provider: "infra" },
      { id: "db", kind: "database", label: "pg", provider: "infra" },
    ],
    edges: [],
    groups: [],
  };
  let sawToolChoice = false;
  const client: EnrichLLMClient = {
    messages: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub of the SDK surface
      create: (async (req: any) => {
        sawToolChoice = req.tool_choice?.name === "propose_services";
        return {
          content: [
            {
              type: "tool_use",
              name: "propose_services",
              id: "t1",
              input: {
                groups: [{ id: "core", label: "Core" }],
                nodePatches: [{ id: "a", group: "core" }],
              },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }) as any,
    } as any,
  };
  const { enrichment } = await enrichTopologyWithClient(client, topology);
  assert.ok(sawToolChoice, "forces propose_services tool");
  assert.equal(enrichment?.groups?.[0]?.id, "core");
  assert.deepEqual(enrichment?.nodePatches, [{ id: "a", label: undefined, group: "core" }]);
});

test("enrichTopologyWithClient returns null for an empty topology without calling the model", async () => {
  let called = false;
  const client: EnrichLLMClient = {
    // biome-ignore lint/suspicious/noExplicitAny: stub
    messages: {
      create: (async () => {
        called = true;
        return {} as any;
      }) as any,
    } as any,
  };
  const { enrichment } = await enrichTopologyWithClient(client, {
    nodes: [],
    edges: [],
    groups: [],
  });
  assert.equal(enrichment, null);
  assert.equal(called, false);
});
