import {
  environmentForResourceAttrs,
  type GroupingCandidateIncident,
  type GroupingNewIssue,
} from "./domain.js";

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
    "Open incident candidate index:",
    JSON.stringify(
      {
        count: input.candidates.length,
        services,
        environments,
        newestCandidates: input.candidates.slice(0, 5).map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          service: candidate.service,
          issueCount: candidate.issueCount,
          lastSeen: candidate.lastSeen,
          environment: environmentForResourceAttrs(candidate.representative?.resourceAttrs),
        })),
      },
      null,
      2,
    ),
    "",
    "Use list_incident_titles/list_incident_facets to orient, then search and inspect plausible join targets.",
  ].join("\n");
}
