// Public facade for the grouping agent. The interesting code lives under
// `grouping/`:
//   - grouping/domain.ts             pure types, parsers, predicates
//   - grouping/candidate-search.ts   pure list/search/inspect/preview helpers
//   - grouping/tools.ts              Anthropic tool schemas + system prompt
//   - grouping/initial-message.ts    user-message construction
//   - grouping/agent.ts              the tool-use loop + LLM client adapter
//
// This module keeps the original exports stable so incident-intake.ts,
// issues/domain.ts and callers don't have to change.
import Anthropic from "@anthropic-ai/sdk";
import { recordTokenUsage } from "./ai-usage.js";
import {
  asGroupingLLMClient,
  type GroupingLLMClient,
  runGroupingAgent,
} from "./grouping/agent.js";
import type {
  GroupingCandidateIncident,
  GroupingNewIssue,
  GroupingVerdict,
} from "./grouping/domain.js";

export type {
  GroupingCandidateIncident,
  GroupingCandidateInvestigation,
  GroupingCandidateIssue,
  GroupingNewIssue,
  GroupingVerdict,
} from "./grouping/domain.js";

const MODEL = process.env.ANTHROPIC_GROUPING_MODEL ?? "claude-sonnet-4-6";

const MAX_TOOL_ITERATIONS = parsePositiveIntegerEnv(
  process.env.INCIDENT_GROUPING_TOOL_ITERATIONS,
  12,
);

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

type GroupingInput = {
  projectName: string;
  orgId: string;
  projectId: string;
  newIssue: GroupingNewIssue;
  candidates: GroupingCandidateIncident[];
};

// Re-exported entry the eval harness still calls. The signature now accepts
// the legacy Anthropic-shaped client (Pick<Anthropic, "messages">) AND our
// GroupingLLMClient — covers both `new Anthropic(...)` and any stub.
export async function analyzeIssueGroupingWithClient(
  client: Pick<Anthropic, "messages"> | GroupingLLMClient,
  input: GroupingInput,
): Promise<GroupingVerdict> {
  const llm: GroupingLLMClient =
    "messages" in client ? asGroupingLLMClient(client) : (client as GroupingLLMClient);
  return runGroupingAgent(
    { projectName: input.projectName, newIssue: input.newIssue, candidates: input.candidates },
    {
      client: llm,
      model: MODEL,
      maxIterations: MAX_TOOL_ITERATIONS,
      accountant: {
        async record(rec) {
          await recordTokenUsage({
            orgId: input.orgId,
            projectId: input.projectId,
            model: rec.model,
            callSite: "grouping",
            usage: rec.usage,
          });
        },
      },
    },
  );
}

export async function analyzeIssueGrouping(input: GroupingInput): Promise<GroupingVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for grouping");
  const client = new Anthropic({ apiKey });
  return analyzeIssueGroupingWithClient(client, input);
}
