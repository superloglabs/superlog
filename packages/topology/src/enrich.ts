// ---------------------------------------------------------------------------
// LLM refinement contract
//
// The deterministic graph (providers + merge) is the source of truth. An LLM is
// asked to produce a `TopologyEnrichment` — a set of *reviewable suggestions*:
// cleaner names + reclassifications, logical groupings, and links telemetry
// didn't capture. `applyEnrichment` folds those onto a topology in a strictly
// ADDITIVE way:
//
//   • it never deletes a node or a deterministic edge,
//   • everything it touches is flagged (`aiProposed` on nodes/groups,
//     `source:"suggested"` on edges) so the UI can render it as "review me",
//   • each of the three capabilities is independently toggleable.
//
// So the worst an LLM can do is propose — a human (or the renderer's accept/reject
// affordance) decides. This same value shape is what the production worker's
// Anthropic pass must emit, which is why it lives here and is unit-tested against
// the baked fixtures.
// ---------------------------------------------------------------------------

import {
  type EdgeKind,
  type GroupTone,
  type NodeKind,
  type Topology,
  type TopologyEdge,
  edgeId,
} from "./topology.js";

export type ProposedGroup = {
  id: string;
  label: string;
  tone: GroupTone;
  intent?: string;
  parent?: string;
};

export type NodePatch = {
  id: string;
  label?: string;
  sublabel?: string;
  kind?: NodeKind;
  group?: string;
};

export type SuggestedEdge = { from: string; to: string; kind?: EdgeKind; label?: string };

export type TopologyEnrichment = {
  /** A one-line rationale the LLM gives for the overall arrangement (shown in UI). */
  summary?: string;
  groups?: ProposedGroup[];
  nodePatches?: NodePatch[];
  suggestedEdges?: SuggestedEdge[];
};

export type EnrichmentToggles = {
  /** Apply label / sublabel / kind reclassification from nodePatches. */
  rename?: boolean;
  /** Apply group assignment + add proposed groups. */
  regroup?: boolean;
  /** Add suggestedEdges as dashed "review me" links. */
  suggestLinks?: boolean;
};

const ALL_ON: Required<EnrichmentToggles> = { rename: true, regroup: true, suggestLinks: true };

export function applyEnrichment(
  topology: Topology,
  enrichment: TopologyEnrichment,
  toggles: EnrichmentToggles = ALL_ON,
): Topology {
  const t = { ...ALL_ON, ...toggles };
  const patchById = new Map((enrichment.nodePatches ?? []).map((p) => [p.id, p]));

  const nodes = topology.nodes.map((n) => {
    const patch = patchById.get(n.id);
    if (!patch) return n;
    const next = { ...n };
    let touched = false;
    if (t.rename) {
      if (patch.label && patch.label !== n.label) {
        next.label = patch.label;
        touched = true;
      }
      if (patch.sublabel !== undefined && patch.sublabel !== n.sublabel) {
        next.sublabel = patch.sublabel;
        touched = true;
      }
      if (patch.kind && patch.kind !== n.kind) {
        next.kind = patch.kind;
        touched = true;
      }
    }
    if (t.regroup && patch.group !== undefined && patch.group !== n.group) {
      next.group = patch.group;
      touched = true;
    }
    return touched ? { ...next, aiProposed: true } : n;
  });

  const groups = t.regroup
    ? dedupeGroups([
        ...topology.groups,
        ...(enrichment.groups ?? []).map((g) => ({
          id: g.id,
          label: g.label,
          tone: g.tone,
          intent: g.intent,
          parentId: g.parent,
          aiProposed: true,
        })),
      ])
    : topology.groups;

  // Additive only: keep every existing edge; append suggestions that don't
  // duplicate a pair the deterministic graph already knows about.
  const edges: TopologyEdge[] = [...topology.edges];
  if (t.suggestLinks && enrichment.suggestedEdges?.length) {
    const known = new Set(edges.map((e) => `${e.from} ${e.to}`));
    const present = new Set(topology.nodes.map((n) => n.id));
    for (const s of enrichment.suggestedEdges) {
      const key = `${s.from} ${s.to}`;
      if (s.from === s.to || known.has(key)) continue;
      if (!present.has(s.from) || !present.has(s.to)) continue;
      known.add(key);
      edges.push({
        id: edgeId(s.from, s.to, s.kind),
        from: s.from,
        to: s.to,
        kind: s.kind,
        source: "suggested",
        label: s.label,
      });
    }
  }

  return { nodes, edges, groups };
}

function dedupeGroups(groups: Topology["groups"]): Topology["groups"] {
  const by = new Map<string, Topology["groups"][number]>();
  for (const g of groups) by.set(g.id, by.get(g.id) ?? g);
  return [...by.values()];
}
