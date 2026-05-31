// Incident intake use case: given a new (or re-seen) Issue, decide whether
// it joins an existing open incident or opens a new one.
//
// The decision is layered:
//   1. Heuristic match (cheap, deterministic, runs on every issue).
//   2. LLM grouping (only for runtime-error issues; alerts skip).
//   3. Open a fresh incident.
//
// Each branch updates the issue's grouping metadata (state + source +
// reason) so the operator can audit why something landed where it did.
//
// All collaborators are injected; the real wiring lives in incident-intake.ts.
import type { schema } from "@superlog/db";
import type { GroupingCandidateIncident, GroupingVerdict } from "../grouping/domain.js";
import {
  type IncidentMatch,
  type IssueGroupingSource,
  buildGroupingCandidate,
  findHeuristicIncidentMatch,
  groupingIssueInput,
  type LinkedIncidentIssue,
} from "../issues/domain.js";

export type IntakeLogger = {
  warn(obj: Record<string, unknown>, msg?: string): void;
};

export type IntakeRepository = {
  findIncidentIssueLink(issueId: string): Promise<schema.IncidentIssue | undefined>;
  findIncident(incidentId: string): Promise<schema.Incident | undefined>;
  findOpenIncidentCandidates(
    issue: schema.Issue,
    opts: { filterService: boolean },
  ): Promise<schema.Incident[]>;
  loadLinkedIncidentIssues(incidents: schema.Incident[]): Promise<LinkedIncidentIssue[]>;
  findProject(projectId: string): Promise<schema.Project | undefined>;
  linkIssueToIncident(opts: {
    incident: schema.Incident;
    issue: schema.Issue;
  }): Promise<boolean>;
  updateIssueGrouping(
    issueId: string,
    opts: {
      state: "pending" | "grouped" | "standalone" | "failed";
      source?: IssueGroupingSource;
      reason?: string | null;
      incrementAttempt?: boolean;
    },
  ): Promise<void>;
};

export type IntakeLifecycle = {
  reopenFromIssueRegression(opts: {
    incident: schema.Incident;
    issue: schema.Issue;
  }): Promise<{ reopened: boolean }>;
  createOpen(opts: {
    projectId: string;
    service: string | null;
    title: string;
    firstSeen: Date;
    lastSeen: Date;
  }): Promise<schema.Incident>;
};

export type GroupingDecider = (input: {
  projectName: string;
  orgId: string;
  projectId: string;
  newIssue: ReturnType<typeof groupingIssueInput>;
  candidates: GroupingCandidateIncident[];
}) => Promise<GroupingVerdict>;

export type IntakeDeps = {
  repo: IntakeRepository;
  lifecycle: IntakeLifecycle;
  analyzeGrouping: GroupingDecider;
  logger: IntakeLogger;
};

export type EnsureIncidentForIssueResult = {
  incident: schema.Incident;
  createdIncident: boolean;
  linkedIssue: boolean;
  reopenedIncident: boolean;
};

type Grouping = {
  match: IncidentMatch | null;
  standaloneSource: IssueGroupingSource;
  standaloneReason: string | null;
  failedReason: string | null;
};

export async function ensureIncidentForIssueWorkflow(
  issue: schema.Issue,
  deps: IntakeDeps,
): Promise<EnsureIncidentForIssueResult> {
  const existingLink = await deps.repo.findIncidentIssueLink(issue.id);
  if (existingLink) {
    const incident = await deps.repo.findIncident(existingLink.incidentId);
    if (incident) {
      const reopen = await deps.lifecycle.reopenFromIssueRegression({ incident, issue });
      const freshIncident = (await deps.repo.findIncident(incident.id)) ?? incident;
      return {
        incident: freshIncident,
        createdIncident: false,
        linkedIssue: false,
        reopenedIncident: reopen.reopened,
      };
    }
  }

  const grouping = await findMatchingIncident(issue, deps);
  let incident = grouping.match?.incident ?? null;
  let createdIncident = false;

  if (!incident) {
    incident = await deps.lifecycle.createOpen({
      projectId: issue.projectId,
      service: issue.service,
      title: issue.title,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
    });
    createdIncident = true;
  }

  const linkedIssue = await deps.repo.linkIssueToIncident({ incident, issue });
  await markIssueGrouping(issue.id, grouping, deps.repo);
  const freshIncident = (await deps.repo.findIncident(incident.id)) ?? incident;
  return { incident: freshIncident, createdIncident, linkedIssue, reopenedIncident: false };
}

async function findMatchingIncident(issue: schema.Issue, deps: IntakeDeps): Promise<Grouping> {
  const heuristic = await findHeuristicMatchingIncident(issue, deps);
  if (heuristic) {
    return { match: heuristic, standaloneSource: null, standaloneReason: null, failedReason: null };
  }
  if (issue.kind === "alert") {
    return {
      match: null,
      standaloneSource: "heuristic",
      standaloneReason: "Alert issues are not LLM-grouped with runtime error incidents.",
      failedReason: null,
    };
  }
  return findLlmMatchingIncident(issue, deps);
}

async function findHeuristicMatchingIncident(
  issue: schema.Issue,
  deps: IntakeDeps,
): Promise<IncidentMatch | null> {
  const candidates = await deps.repo.findOpenIncidentCandidates(issue, { filterService: true });
  if (candidates.length === 0) return null;
  const linked = await deps.repo.loadLinkedIncidentIssues(candidates);
  return findHeuristicIncidentMatch(issue, candidates, linked);
}

async function findLlmMatchingIncident(
  issue: schema.Issue,
  deps: IntakeDeps,
): Promise<Grouping> {
  const candidates = await deps.repo.findOpenIncidentCandidates(issue, { filterService: false });
  if (candidates.length === 0) {
    return {
      match: null,
      standaloneSource: "heuristic",
      standaloneReason: "No open incidents in this project.",
      failedReason: null,
    };
  }

  const linked = await deps.repo.loadLinkedIncidentIssues(candidates);
  const groupingCandidates = candidates
    .map((incident) => buildGroupingCandidate(incident, linked))
    .filter((candidate): candidate is GroupingCandidateIncident => candidate !== null);
  if (groupingCandidates.length === 0) {
    return {
      match: null,
      standaloneSource: "heuristic",
      standaloneReason: "No candidate incidents had linked issue context.",
      failedReason: null,
    };
  }

  const project = await deps.repo.findProject(issue.projectId);

  await deps.repo.updateIssueGrouping(issue.id, {
    state: "pending",
    source: "llm",
    reason: "Waiting for LLM grouping.",
    incrementAttempt: true,
  });

  try {
    const verdict = await deps.analyzeGrouping({
      projectName: project?.name ?? issue.projectId,
      orgId: project?.orgId ?? "",
      projectId: issue.projectId,
      newIssue: groupingIssueInput(issue),
      candidates: groupingCandidates,
    });
    if (verdict.decision === "join") {
      const incident = candidates.find((c) => c.id === verdict.incidentId) ?? null;
      if (!incident) {
        return {
          match: null,
          standaloneSource: "llm",
          standaloneReason: "LLM selected an unknown incident.",
          failedReason: null,
        };
      }
      return {
        match: { incident, source: "llm", reason: verdict.evidence },
        standaloneSource: null,
        standaloneReason: null,
        failedReason: null,
      };
    }
    return {
      match: null,
      standaloneSource: "llm",
      standaloneReason: verdict.evidence ?? "LLM did not find enough evidence to join an incident.",
      failedReason: null,
    };
  } catch (err) {
    const reason = `LLM grouping failed: ${err instanceof Error ? err.message : String(err)}`;
    deps.logger.warn(
      {
        scope: "issue_grouping",
        issue_id: issue.id,
        project_id: issue.projectId,
        err,
      },
      "llm grouping failed",
    );
    return { match: null, standaloneSource: "llm", standaloneReason: null, failedReason: reason };
  }
}

async function markIssueGrouping(
  issueId: string,
  grouping: Grouping,
  repo: Pick<IntakeRepository, "updateIssueGrouping">,
): Promise<void> {
  if (grouping.match) {
    await repo.updateIssueGrouping(issueId, {
      state: "grouped",
      source: grouping.match.source,
      reason: grouping.match.reason,
    });
    return;
  }
  if (grouping.failedReason) {
    await repo.updateIssueGrouping(issueId, {
      state: "failed",
      source: "llm",
      reason: grouping.failedReason,
    });
    return;
  }
  await repo.updateIssueGrouping(issueId, {
    state: "standalone",
    source: grouping.standaloneSource,
    reason: grouping.standaloneReason,
  });
}
