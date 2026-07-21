import {
  environmentForResourceAttrs,
  type GroupingCandidateIncident,
  type GroupingNewIssue,
} from "./domain.js";

// One compact line per candidate so the model sees the WHOLE candidate set
// up front instead of discovering it through blind tool calls. ~40-60 tokens
// per candidate; even a few hundred open incidents fit comfortably. Details
// (stack traces, sibling issues) stay behind inspect_incident.
function candidateIndexLine(candidate: GroupingCandidateIncident): string {
  const representative = candidate.representative;
  const issue = candidate.issues?.[0];
  const codePath = issue?.logAttrs?.["code.file.path"];
  const codeFn = issue?.logAttrs?.["code.function.name"];
  const parts = [
    candidate.id,
    `[${candidate.service ?? "?"}]`,
    candidate.title,
    representative
      ? `| ${representative.exceptionType}: ${(representative.message ?? "").slice(0, 140)}`
      : "",
    codePath ? `| at ${codePath}${codeFn ? `:${codeFn}` : ""}` : "",
    `| issues=${candidate.issueCount} lastSeen=${candidate.lastSeen}`,
  ];
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ");
}

export function buildInitialUserMessage(input: {
  projectName: string;
  newIssue: GroupingNewIssue;
  candidates: GroupingCandidateIncident[];
}): string {
  const services = Array.from(
    new Set(input.candidates.map((candidate) => candidate.service).filter(Boolean)),
  ).sort();
  const environments = Array.from(
    new Set(
      input.candidates
        .map((candidate) =>
          environmentForResourceAttrs(candidate.representative?.resourceAttrs),
        )
        .filter((env): env is string => !!env),
    ),
  ).sort();
  return [
    `Project: ${input.projectName}`,
    "",
    "New issue to classify:",
    JSON.stringify(input.newIssue, null, 2),
    "",
    `Open incident candidates (${input.candidates.length} total, services: ${services.join(", ") || "-"}, environments: ${environments.join(", ") || "-"}), one per line:`,
    ...input.candidates.map(candidateIndexLine),
    "",
    "Inspect any plausible join target with inspect_incident before deciding; search_incidents/list_incident_titles remain available for narrowing.",
  ].join("\n");
}
