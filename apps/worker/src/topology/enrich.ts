// LLM enrichment: given a deterministic topology, ask Claude once to organize it
// into a few logical *services by intent*, clean node labels, and suggest links
// the telemetry missed. Returns a `TopologyEnrichment` (the same shape the spike
// baked by hand) or null when the model is unavailable/unusable. Mirrors the
// inline-Anthropic pattern in grouping.ts; structured output via a single forced
// tool call, validated by a pure parser (repo has no zod in the worker).

import Anthropic from "@anthropic-ai/sdk";
import type {
  GroupTone,
  NodePatch,
  ProposedGroup,
  SuggestedEdge,
  Topology,
  TopologyEnrichment,
} from "@superlog/topology";
import { recordTokenUsage } from "../ai-usage.js";
import { logger } from "../logger.js";

const MODEL = process.env.ANTHROPIC_TOPOLOGY_MODEL ?? "claude-sonnet-4-6";
const TONES: GroupTone[] = ["accent", "success", "warning", "neutral", "danger"];

const SYSTEM_PROMPT = [
  "You organize a cloud system's resources into a HIERARCHY of logical SERVICES BY INTENT —",
  "what each group is *for* (e.g. 'Web app', 'API & backend', 'Telemetry pipeline'), NOT by infra tier.",
  "Keep the TOP level small (2–5 services). Use NESTING (a group's `parent`) for natural sub-systems:",
  "e.g. a 'Telemetry pipeline' service containing a 'ClickHouse cluster' sub-group that holds the",
  "replica/keeper nodes. Assign every node to exactly one LEAF group. Give each group a 3–8 word intent.",
  "Relabel nodes to clean, human names (drop env prefixes/suffixes).",
  "Do NOT create an 'external integrations'/'third-party' group — those resources are not on this map.",
  "Suggest a few links that clearly exist but aren't in the observed edges (e.g. an API reads its database).",
  "Only reference node ids that were given. Call propose_services exactly once.",
].join(" ");

const PROPOSE_SERVICES_TOOL: Anthropic.Messages.Tool = {
  name: "propose_services",
  description:
    "Your final grouping of the system into logical services, node relabels, and suggested links.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One sentence describing the grouping you chose." },
      groups: {
        type: "array",
        description: "The logical services (2–6).",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "short slug, e.g. 'backend'" },
            label: { type: "string" },
            intent: { type: "string" },
            tone: { type: "string", enum: TONES },
            parent: {
              type: "string",
              description:
                "optional id of the parent group, for nesting (omit for a top-level service)",
            },
          },
          required: ["id", "label"],
        },
      },
      nodePatches: {
        type: "array",
        description: "Per-node relabel + service assignment. One entry per node id.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "an existing node id" },
            label: { type: "string" },
            group: { type: "string", description: "id of one of the proposed groups" },
          },
          required: ["id", "group"],
        },
      },
      suggestedEdges: {
        type: "array",
        description: "Links that obviously exist but weren't observed.",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            kind: { type: "string" },
          },
          required: ["from", "to"],
        },
      },
    },
    required: ["groups", "nodePatches"],
  },
};

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Validate a `propose_services` tool input into a TopologyEnrichment. Pure: filters
 * out malformed entries and anything referencing unknown nodes/groups rather than
 * throwing, so a partially-good answer is still usable.
 */
export function parseEnrichmentToolInput(
  input: unknown,
  knownNodeIds: Set<string>,
): TopologyEnrichment | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

  const rawGroups: {
    id: string;
    label: string;
    intent?: string;
    tone: GroupTone;
    parent?: string;
  }[] = [];
  for (const g of arr(obj.groups)) {
    const id = asStr(g.id);
    const label = asStr(g.label);
    if (!id || !label) continue;
    const tone: GroupTone = TONES.includes(g.tone as GroupTone) ? (g.tone as GroupTone) : "neutral";
    rawGroups.push({ id, label, intent: asStr(g.intent), tone, parent: asStr(g.parent) });
  }
  if (rawGroups.length === 0) return null;
  const groupIds = new Set(rawGroups.map((g) => g.id));
  // A parent is valid only when it references another proposed group (not self).
  const directParent = new Map<string, string | undefined>(
    rawGroups.map((g) => [
      g.id,
      g.parent && g.parent !== g.id && groupIds.has(g.parent) ? g.parent : undefined,
    ]),
  );
  // Cut a parent link only when walking up from it returns to the group itself —
  // that's the back-edge of a cycle (A→B→A would otherwise orphan A and B from
  // every rendered level). A group that merely points INTO a cycle keeps its link
  // (the cycle gets cut at its own back-edge instead).
  const acyclicParent = (id: string): string | undefined => {
    const p0 = directParent.get(id);
    if (!p0) return undefined;
    const seen = new Set<string>();
    let p: string | undefined = p0;
    while (p) {
      if (p === id) return undefined; // cycle through `id` → cut its link
      if (seen.has(p)) return p0; // downstream cycle, not through `id` → keep link
      seen.add(p);
      p = directParent.get(p);
    }
    return p0;
  };
  const groups: ProposedGroup[] = rawGroups.map((g) => ({
    id: g.id,
    label: g.label,
    intent: g.intent,
    tone: g.tone,
    parent: acyclicParent(g.id),
  }));

  const nodePatches: NodePatch[] = [];
  for (const p of arr(obj.nodePatches)) {
    const id = asStr(p.id);
    const group = asStr(p.group);
    if (!id || !knownNodeIds.has(id) || !group || !groupIds.has(group)) continue;
    nodePatches.push({ id, label: asStr(p.label), group });
  }

  const suggestedEdges: SuggestedEdge[] = [];
  for (const e of arr(obj.suggestedEdges)) {
    const from = asStr(e.from);
    const to = asStr(e.to);
    if (!from || !to || from === to || !knownNodeIds.has(from) || !knownNodeIds.has(to)) continue;
    suggestedEdges.push({ from, to, kind: asStr(e.kind) });
  }

  return { summary: asStr(obj.summary), groups, nodePatches, suggestedEdges };
}

function buildUserMessage(topology: Topology): string {
  const nodes = topology.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    kind: n.kind,
    sublabel: n.sublabel,
  }));
  const edges = topology.edges.map((e) => ({
    from: e.from,
    to: e.to,
    kind: e.kind,
    source: e.source,
  }));
  return [
    "Here is the system's resource graph. Group it into logical services by intent.",
    `Nodes:\n${JSON.stringify(nodes, null, 0)}`,
    `Observed edges:\n${JSON.stringify(edges, null, 0)}`,
  ].join("\n\n");
}

export type EnrichLLMClient = Pick<Anthropic, "messages">;

export async function enrichTopologyWithClient(
  client: EnrichLLMClient,
  topology: Topology,
): Promise<{ enrichment: TopologyEnrichment | null; usage: Anthropic.Messages.Usage | undefined }> {
  if (topology.nodes.length === 0) return { enrichment: null, usage: undefined };
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [PROPOSE_SERVICES_TOOL],
    tool_choice: { type: "tool", name: "propose_services" },
    messages: [{ role: "user", content: buildUserMessage(topology) }],
  });
  const toolUse = message.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
  );
  const known = new Set(topology.nodes.map((n) => n.id));
  const enrichment = toolUse ? parseEnrichmentToolInput(toolUse.input, known) : null;
  return { enrichment, usage: message.usage };
}

/**
 * Run the enrichment against the real Anthropic API. Opts out (returns null) when
 * `ANTHROPIC_API_KEY` is absent, so stock builds without the key stay inert.
 */
export async function enrichProjectTopology(
  topology: Topology,
  ctx: { orgId: string; projectId: string },
): Promise<TopologyEnrichment | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  // Enrichment is best-effort: a transient Anthropic failure must NOT sink the
  // build — the deterministic graph still persists, just without AI grouping.
  let enrichment: TopologyEnrichment | null;
  let usage: Anthropic.Messages.Usage | undefined;
  try {
    ({ enrichment, usage } = await enrichTopologyWithClient(client, topology));
  } catch (err) {
    logger.warn(
      { projectId: ctx.projectId, err: err instanceof Error ? err.message : String(err) },
      "topology enrichment failed — persisting deterministic graph only",
    );
    return null;
  }
  if (usage) {
    try {
      await recordTokenUsage({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        model: MODEL,
        callSite: "topology",
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        },
      });
    } catch {
      // best-effort accounting
    }
  }
  return enrichment;
}
