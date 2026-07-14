// Which incident-detail tabs are worth showing. Activity is always there;
// Findings and PR only appear once they have content, so a fresh incident
// isn't a wall of empty tabs.

export type IncidentDetailTab = "activity" | "findings" | "pr";

// Structural subsets of the api.ts Incident / AgentRun types — keeps this
// decidable in tests without constructing full API objects.
type FindingsIncident = {
  agentSummary: string | null;
  rootCauseText: string | null;
  estimatedImpactText: string | null;
  resolutionClassification: unknown;
};

type FindingsAgentRun = {
  failureReason: string | null;
  result: {
    summary?: string | null;
    question?: string | null;
    rootCause?: unknown;
    estimatedImpact?: unknown;
    resolutionClassification?: unknown;
  } | null;
};

// Same defensive shape check as AgentRunView's isConfidenceField: agent-emitted
// result fields are sometimes malformed (e.g. a flat string in place of
// { text, confidence }), and AgentRunView renders nothing for those — so they
// must not count as visible findings either.
function isConfidenceField(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { text?: unknown }).text === "string" &&
    typeof (v as { confidence?: unknown }).confidence === "number"
  );
}

// Mirrors what the Findings tab actually renders (AgentRunView + the
// resolution-proposal banner): flattened incident findings, the run result's
// fallbacks, an ask_human question, or a failure reason.
export function incidentHasFindings({
  incident,
  agentRun,
  hasPendingResolutionProposal,
}: {
  incident: FindingsIncident;
  agentRun: FindingsAgentRun | null;
  hasPendingResolutionProposal: boolean;
}): boolean {
  if (hasPendingResolutionProposal) return true;
  if (
    incident.agentSummary ||
    incident.rootCauseText ||
    incident.estimatedImpactText ||
    incident.resolutionClassification
  ) {
    return true;
  }
  if (!agentRun) return false;
  if (agentRun.failureReason) return true;
  const result = agentRun.result;
  if (!result) return false;
  return !!(
    result.summary ||
    result.question ||
    isConfidenceField(result.rootCause) ||
    isConfidenceField(result.estimatedImpact) ||
    (result.resolutionClassification && typeof result.resolutionClassification === "object")
  );
}

export function visibleIncidentDetailTabs({
  hasFindings,
  hasPullRequests,
}: {
  hasFindings: boolean;
  hasPullRequests: boolean;
}): IncidentDetailTab[] {
  const tabs: IncidentDetailTab[] = ["activity"];
  if (hasFindings) tabs.push("findings");
  if (hasPullRequests) tabs.push("pr");
  return tabs;
}

export function resolveIncidentDetailTab(
  selected: IncidentDetailTab,
  visible: IncidentDetailTab[],
): IncidentDetailTab {
  return visible.includes(selected) ? selected : "activity";
}
