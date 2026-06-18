import Anthropic from "@anthropic-ai/sdk";
import { recordTokenUsage } from "./ai-usage.js";

const MODEL = process.env.ANTHROPIC_MERGE_MODEL ?? "claude-sonnet-4-6";
const MIN_EVIDENCE_LENGTH = 20;

export type MergeCandidateIncident = {
  id: string;
  title: string;
  service: string | null;
  firstSeen: string;
  lastSeen: string;
  issueCount: number;
  proposedTitle: string | null;
  summary: string | null;
  // Files the incident's investigation proposed changing (the validated patch's
  // changed files). May already be in an open/closed/merged PR. Two incidents
  // whose fixes touch the same files are strong evidence of one root cause —
  // even when their surface symptoms (vendor, exception text) differ.
  fixTargets: string[] | null;
  // The state of the most recent PR the incident produced, if any. A closed PR
  // is NOT a reason to ignore the incident: it still means "we already proposed
  // this fix here", so a same-root-cause source should merge in, not re-open.
  priorPrState: "open" | "closed" | "merged" | null;
  representative: {
    exceptionType: string;
    message: string | null;
    topFrame: string | null;
    normalizedFrames: string[];
  } | null;
};

export type MergeSourceIncident = Omit<MergeCandidateIncident, "id">;

export type MergeVerdict =
  | { decision: "merge"; targetIncidentId: string; evidence: string }
  | { decision: "standalone"; evidence: string | null };

const SYSTEM_PROMPT = [
  "You decide whether two completed incident agent_runs describe the same underlying root cause and should be merged into one incident.",
  "You have full agent agent run context on both sides: a one-paragraph summary of the root cause, a proposed title, and one representative error issue.",
  "An incident represents one underlying root cause. Distinct error symptoms can belong to the same incident if the agent_runs conclude the same root cause (e.g. one Composio MCP timeout pattern manifesting through multiple tool names; one Postgres pool exhaustion manifesting as different query failures).",
  "Default to 'standalone'. Return 'merge' only when the two agent run summaries clearly describe the same root cause.",
  "Examples that DO justify merging:",
  "  - Both summaries identify the same upstream dependency, external API, database object, or migration as the cause.",
  "  - Both summaries describe the same code path, the same misconfiguration, or the same fix.",
  "  - One incident is the canonical fault and the other is a documented downstream symptom of it (per the summaries themselves).",
  "Fix targets are decisive evidence. Each incident may include `fixTargets`: the files the agent's validated fix would change. If the source and a candidate would change the SAME file(s) (especially the same function), treat that as strong positive evidence of one shared root cause and prefer 'merge' — even if the vendor, exception class, or error text differ (e.g. per-vendor symptoms of one shared handler bug).",
  "A candidate's `priorPrState` tells you it already produced a PR. A 'closed' (unmerged) PR is NOT a reason to skip it: it means a fix for this root cause was already proposed there, so a same-root-cause source should merge into it rather than open a duplicate PR.",
  "Examples that do NOT justify merging:",
  "  - Same exception class but different root causes per the summaries.",
  "  - Same service, unrelated bugs.",
  "  - Both happen to fail on a third party (Slack, Composio, etc.) but for different APIs / endpoints / reasons.",
  "When the summaries do not give you positive evidence of a shared root cause, return 'standalone'.",
  "Respond with a single JSON object only, no prose, no markdown fences, matching exactly:",
  '{"decision":"merge","incidentId":"<one of the candidate ids>","evidence":"<>=20 chars naming the shared root cause>"}',
  "or",
  '{"decision":"standalone","evidence":"<short reason or null>"}',
].join("\n");

export function buildUserMessage(input: {
  projectName: string;
  source: MergeSourceIncident;
  candidates: MergeCandidateIncident[];
}): string {
  const candidateBlock =
    input.candidates.length === 0
      ? "<no open incidents>"
      : JSON.stringify(input.candidates, null, 2);
  return [
    `Project: ${input.projectName}`,
    "",
    "Open incidents (any of these can be a merge target):",
    candidateBlock,
    "",
    "Source incident (just completed agent run):",
    JSON.stringify(input.source, null, 2),
    "",
    "Decide: merge into one of the candidates, or standalone.",
  ].join("\n");
}

function extractText(message: Anthropic.Messages.Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function parseVerdict(raw: string, candidateIds: Set<string>): MergeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decision: "standalone", evidence: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { decision: "standalone", evidence: null };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.decision === "merge") {
    const targetIncidentId = typeof obj.incidentId === "string" ? obj.incidentId : "";
    const evidence = typeof obj.evidence === "string" ? obj.evidence.trim() : "";
    if (candidateIds.has(targetIncidentId) && evidence.length >= MIN_EVIDENCE_LENGTH) {
      return { decision: "merge", targetIncidentId, evidence };
    }
    return { decision: "standalone", evidence: null };
  }
  const evidence =
    typeof obj.evidence === "string" && obj.evidence.trim().length > 0 ? obj.evidence.trim() : null;
  return { decision: "standalone", evidence };
}

export async function analyzeMergeAfterAgentRun(input: {
  projectName: string;
  orgId: string;
  projectId: string;
  source: MergeSourceIncident;
  candidates: MergeCandidateIncident[];
}): Promise<MergeVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for merge analysis");
  if (input.candidates.length === 0) {
    return { decision: "standalone", evidence: null };
  }
  const client = new Anthropic({ apiKey });

  const userMessage = buildUserMessage(input);
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  await recordTokenUsage({
    orgId: input.orgId,
    projectId: input.projectId,
    model: MODEL,
    callSite: "merge",
    usage: {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
      cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? 0,
    },
  });

  const text = extractText(message);
  const candidateIds = new Set(input.candidates.map((c) => c.id));
  return parseVerdict(text, candidateIds);
}
