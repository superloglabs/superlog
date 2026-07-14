// Incident intake use case: given a new (or re-seen) Issue, decide whether
// it joins an existing open incident or opens a new one.
//
// The decision is layered:
//   1. Heuristic match (cheap, deterministic, runs on every issue). For
//      alert-episode issues this includes joining the open incident already
//      driven by an episode of the same alert+group.
//   2. LLM grouping (errors and alert episodes alike).
//   3. Open a fresh incident — chained to the latest closed same-alert
//      incident when the issue is a new breach of an already-seen alert.
//
// Each branch updates the issue's grouping metadata (state + source +
// reason) so the operator can audit why something landed where it did.
//
// All collaborators are injected; the real wiring lives in incident-intake.ts.
import { environmentFromResourceAttrs, type schema } from "@superlog/db";
import type { GroupingCandidateIncident, GroupingVerdict } from "../grouping/domain.js";
import {
  type IncidentMatch,
  type IssueGroupingSource,
  type LinkedIncidentIssue,
  buildGroupingCandidate,
  findHeuristicIncidentMatch,
  findSameTraceIncidentMatch,
  groupingIssueInput,
  issueSample,
} from "../issues/domain.js";

export type IntakeLogger = {
  warn(obj: Record<string, unknown>, msg?: string): void;
};

export type IntakeRepository = {
  // Newest incident_issues link — an issue keeps one link per incident it has
  // driven over its life, so the latest link is its current incident.
  findLatestIncidentIssueLink(issueId: string): Promise<schema.IncidentIssue | undefined>;
  findIncident(incidentId: string): Promise<schema.Incident | undefined>;
  findOpenRecurrenceForIncident(previousIncidentId: string): Promise<schema.Incident | undefined>;
  reopenIssue(issueId: string): Promise<void>;
  touchIncidentLastSeen(incidentId: string, lastSeen: Date): Promise<void>;
  // The episode an alert-episode issue is 1:1 with — carries the alert
  // identity (alertId + groupKey) that fingerprints no longer encode.
  findAlertEpisodeForIssue(issueId: string): Promise<schema.AlertEpisode | undefined>;
  // Newest open / newest overall incident driven by an episode of the same
  // alert+group. "Open" is the join target for a new breach; "latest" (when
  // closed) is the predecessor a standalone new breach chains to.
  findOpenIncidentForAlert(alertId: string, groupKey: string): Promise<schema.Incident | undefined>;
  findLatestIncidentForAlert(
    alertId: string,
    groupKey: string,
  ): Promise<schema.Incident | undefined>;
  findOpenIncidentCandidates(
    issue: schema.Issue,
    opts: { filterService: boolean },
  ): Promise<schema.Incident[]>;
  loadLinkedIncidentIssues(incidents: schema.Incident[]): Promise<LinkedIncidentIssue[]>;
  findProject(projectId: string): Promise<schema.Project | undefined>;
  linkIssueToIncident(opts: {
    incident: schema.Incident;
    issue: schema.Issue;
  }): Promise<LinkIssueToIncidentOutcome>;
  updateIssueGrouping(
    issueId: string,
    opts: {
      state: "pending" | "grouped" | "standalone" | "failed";
      source?: IssueGroupingSource;
      reason?: string | null;
      incrementAttempt?: boolean;
      // Only apply when the current state is 'pending' (see the losing-racer
      // path in the serialized create section).
      onlyIfPending?: boolean;
      // Only apply when grouping isn't already decided (source IS NULL) or is
      // retryable ('pending'/'failed'). Guards the out-of-lock 'pending' marker
      // so a losing racer can't clobber the winner's grouped/standalone verdict.
      onlyIfUndecided?: boolean;
    },
  ): Promise<void>;
};

export type LinkIssueToIncidentOutcome = "linked" | "already_linked" | "incident_closed";

export type IntakeLifecycle = {
  openRecurrence(opts: {
    previousIncident: schema.Incident;
    issue: schema.Issue;
    origin: "resolved_issue_recurred" | "escalation_trigger" | "alert_breached_again";
    environment?: string | null;
  }): Promise<schema.Incident>;
  createOpen(opts: {
    projectId: string;
    service: string | null;
    environment?: string | null;
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
  // Optional mutual-exclusion hook around the workflow's read-then-create
  // section (deciding on + creating/linking the incident, AFTER grouping
  // analysis). Wired for alert-episode issues, where concurrent duplicates of
  // the same issue can reach intake together. fn re-checks the issue's link
  // first, so the racer that lost the lock re-lands on the winner's incident.
  // Deliberately excludes the LLM grouping call — implementations may hold a
  // database connection for fn's whole duration.
  serializeCreate?: <T>(keys: readonly string[], fn: () => Promise<T>) => Promise<T>;
};

export type IssueIntakeTransition = "new" | "recurred" | "escalated";

export type EnsureIncidentForIssueResult = {
  incident: schema.Incident;
  createdIncident: boolean;
  linkedIssue: boolean;
  // The incident was opened because a resolved issue recurred (chained to its
  // predecessor via previous_incident_id).
  recurrenceIncident: boolean;
};

type Grouping = {
  match: IncidentMatch | null;
  standaloneSource: IssueGroupingSource;
  standaloneReason: string | null;
  failedReason: string | null;
};

class IncidentClosedDuringLink extends Error {
  constructor(readonly incidentId: string) {
    super(`Incident ${incidentId} closed while linking an Issue`);
  }
}

export async function ensureIncidentForIssueWorkflow(
  issue: schema.Issue,
  transition: IssueIntakeTransition,
  deps: IntakeDeps,
): Promise<EnsureIncidentForIssueResult> {
  // A candidate can close after grouping selects it but before the Issue link
  // is written. The repository reports that lifecycle race explicitly. Unwind
  // any serialization transaction, then rerun from fresh Incident state; each
  // retry observes at least one additional closed candidate, so the workflow
  // makes progress without dropping this at-most-once transition.
  for (;;) {
    try {
      return await ensureIncidentForIssueAttempt(issue, transition, deps);
    } catch (err) {
      if (!(err instanceof IncidentClosedDuringLink)) throw err;
      deps.logger.warn(
        { issueId: issue.id, incidentId: err.incidentId },
        "Incident closed while linking Issue; regrouping against fresh state",
      );
    }
  }
}

async function linkIssueToOpenIncident(
  repo: IntakeRepository,
  incident: schema.Incident,
  issue: schema.Issue,
): Promise<boolean> {
  const outcome = await repo.linkIssueToIncident({ incident, issue });
  if (outcome === "incident_closed") throw new IncidentClosedDuringLink(incident.id);
  return outcome === "linked";
}

async function ensureIncidentForIssueAttempt(
  issue: schema.Issue,
  transition: IssueIntakeTransition,
  deps: IntakeDeps,
): Promise<EnsureIncidentForIssueResult> {
  // Serialize intake by trace id when present, so same-request symptoms — a span
  // exception and its own log line, which are DIFFERENT issues — can't each open
  // an incident under concurrent pg-boss jobs. Falls back to the issue id (the
  // alert-episode / same-issue case). Recurrences use their predecessor id
  // in addition, so both same-request and same-predecessor symptoms converge.
  const traceId = issueSample(issue)?.traceId;
  const serializeKeys = traceId ? [`trace:${traceId}`] : [issue.id];
  const serialize = deps.serializeCreate ?? ((_keys, fn) => fn());

  const existingLink = await deps.repo.findLatestIncidentIssueLink(issue.id);

  if ((transition === "recurred" || transition === "escalated") && existingLink) {
    const previous = await deps.repo.findIncident(existingLink.incidentId);
    if (previous) {
      // Retry-idempotency: if a prior attempt already opened the recurrence
      // incident, the latest link points at an open incident — reuse it.
      if (previous.status === "open") {
        await deps.repo.reopenIssue(issue.id);
        return {
          incident: previous,
          createdIncident: false,
          linkedIssue: false,
          recurrenceIncident: false,
        };
      }
      // A recurrence opens a NEW incident chained to its predecessor — but if a
      // related issue already has an open incident, run the same grouping
      // pipeline as a first occurrence and join that incident instead. The
      // potentially slow LLM call stays outside the serialized section.
      let grouping = await findMatchingIncident(issue, deps);
      let matched = grouping.match?.incident ?? null;
      const recurrenceKeys = [
        `recurrence:${previous.id}`,
        ...(traceId ? [`trace:${traceId}`] : []),
      ];
      return serialize(recurrenceKeys, async () => {
        // Re-read the latest link now that we hold the lock: a concurrent
        // recurrence job for this same issue may have already opened the
        // recurrence incident — re-land on it instead of opening a second, and
        // don't let the same-trace lookup below match the issue's own fresh
        // incident. Mirrors the tail create path's `raceLink` re-check.
        const raceLink = await deps.repo.findLatestIncidentIssueLink(issue.id);
        if (raceLink) {
          const landed = await deps.repo.findIncident(raceLink.incidentId);
          if (landed?.status === "open") {
            await deps.repo.reopenIssue(issue.id);
            return {
              incident: landed,
              createdIncident: false,
              linkedIssue: false,
              recurrenceIncident: false,
            };
          }
        }
        // The grouping decision ran before acquiring the lock. A sibling
        // recurrence may have opened an incident while this issue was being
        // analysed, so converge on that successor before trusting a stale
        // standalone verdict. Recurrences of one predecessor share the same
        // lock key, making this deterministic even when neither log has trace
        // context.
        if (!matched) {
          const openRecurrence = await deps.repo.findOpenRecurrenceForIncident(previous.id);
          if (openRecurrence) {
            grouping = {
              match: {
                incident: openRecurrence,
                source: "heuristic",
                reason: "Joined the open recurrence of the same previous incident.",
              },
              standaloneSource: null,
              standaloneReason: null,
              failedReason: null,
            };
            matched = openRecurrence;
          }
        }
        if (!matched && traceId) {
          const sameTrace = await findSameTraceMatchingIncident(issue, deps);
          if (sameTrace) {
            grouping = {
              match: sameTrace,
              standaloneSource: null,
              standaloneReason: null,
              failedReason: null,
            };
            matched = sameTrace.incident;
          }
        }
        if (matched) {
          const linkedIssue = await linkIssueToOpenIncident(deps.repo, matched, issue);
          await deps.repo.reopenIssue(issue.id);
          await markIssueGrouping(issue.id, grouping, deps.repo);
          const fresh = (await deps.repo.findIncident(matched.id)) ?? matched;
          return {
            incident: fresh,
            createdIncident: false,
            linkedIssue,
            recurrenceIncident: false,
          };
        }
        const incident = await deps.lifecycle.openRecurrence({
          previousIncident: previous,
          issue,
          origin: transition === "escalated" ? "escalation_trigger" : "resolved_issue_recurred",
          environment: environmentFromResourceAttrs(issue.lastSample?.resourceAttrs),
        });
        await markIssueGrouping(issue.id, grouping, deps.repo);
        return { incident, createdIncident: true, linkedIssue: true, recurrenceIncident: true };
      });
    }
  }

  if (existingLink) {
    const incident = await deps.repo.findIncident(existingLink.incidentId);
    if (incident) {
      if (incident.status === "open") {
        await deps.repo.touchIncidentLastSeen(incident.id, issue.lastSeen);
      }
      const freshIncident = (await deps.repo.findIncident(incident.id)) ?? incident;
      return {
        incident: freshIncident,
        createdIncident: false,
        linkedIssue: false,
        recurrenceIncident: false,
      };
    }
  }

  // Alert-episode issues are fresh every breach, so the same-alert
  // relationship lives on the episodes rather than the fingerprint: a new
  // breach joins the alert's open incident when one exists, and remembers the
  // latest closed one to chain to if it ends up standalone.
  const alertContext = issue.kind === "alert" ? await loadAlertIncidentContext(issue, deps) : null;
  if (alertContext?.openIncident) {
    const open = alertContext.openIncident;
    const linkedIssue = await linkIssueToOpenIncident(deps.repo, open, issue);
    await deps.repo.updateIssueGrouping(issue.id, {
      state: "grouped",
      source: "heuristic",
      reason: "New episode of an alert whose incident is still open.",
    });
    const freshIncident = (await deps.repo.findIncident(open.id)) ?? open;
    return {
      incident: freshIncident,
      createdIncident: false,
      linkedIssue,
      recurrenceIncident: false,
    };
  }

  let grouping = await findMatchingIncident(issue, deps);
  let matched = grouping.match?.incident ?? null;

  // The tail below is the workflow's one read-then-create section: everything
  // above only joins existing incidents with idempotent writes. It runs under
  // the trace-keyed serialization hook (computed at the top) with same-trace and
  // link re-checks inside, so a racer that created the incident first wins and
  // the loser re-lands on it. The grouping analysis (which can call an LLM)
  // stays outside the hook.
  return serialize(serializeKeys, async () => {
    const raceLink = await deps.repo.findLatestIncidentIssueLink(issue.id);
    if (raceLink) {
      const existing = await deps.repo.findIncident(raceLink.incidentId);
      if (existing) {
        if (existing.status === "open") {
          await deps.repo.touchIncidentLastSeen(existing.id, issue.lastSeen);
        }
        // This losing invocation may have written 'pending' during its own
        // grouping analysis, possibly AFTER the winner recorded its verdict.
        // Clear only that leftover marker (onlyIfPending guards the winner's
        // recorded verdict) and record *this* evaluation's own grouping
        // result rather than a hard-coded 'grouped/heuristic' — which would
        // mislabel the issue when the winner actually went standalone/failed
        // or grouped via the LLM.
        await markIssueGrouping(issue.id, grouping, deps.repo, { onlyIfPending: true });
        return {
          incident: existing,
          createdIncident: false,
          linkedIssue: false,
          recurrenceIncident: false,
        };
      }
    }

    // Same-request race: we resolved grouping outside the lock, so a sibling
    // symptom sharing this trace may have opened the incident since. Now that we
    // hold the trace-keyed lock, re-check and join it rather than duplicating.
    if (!matched) {
      const sameTrace = await findSameTraceMatchingIncident(issue, deps);
      if (sameTrace) {
        grouping = {
          match: sameTrace,
          standaloneSource: null,
          standaloneReason: null,
          failedReason: null,
        };
        matched = sameTrace.incident;
      }
    }

    if (!matched && alertContext?.previousIncident) {
      const recurrence = await deps.lifecycle.openRecurrence({
        previousIncident: alertContext.previousIncident,
        issue,
        origin: "alert_breached_again",
        environment: environmentFromResourceAttrs(issue.lastSample?.resourceAttrs),
      });
      await deps.repo.updateIssueGrouping(issue.id, {
        state: "standalone",
        source: "heuristic",
        reason: "New breach of an alert whose previous incident is closed; chained to it.",
      });
      return {
        incident: recurrence,
        createdIncident: true,
        linkedIssue: true,
        recurrenceIncident: true,
      };
    }

    let incident = matched;
    let createdIncident = false;
    if (!incident) {
      incident = await deps.lifecycle.createOpen({
        projectId: issue.projectId,
        service: issue.service,
        environment: environmentFromResourceAttrs(issue.lastSample?.resourceAttrs),
        title: issue.title,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
      });
      createdIncident = true;
    }

    const linkedIssue = await linkIssueToOpenIncident(deps.repo, incident, issue);
    await markIssueGrouping(issue.id, grouping, deps.repo);
    const freshIncident = (await deps.repo.findIncident(incident.id)) ?? incident;
    return { incident: freshIncident, createdIncident, linkedIssue, recurrenceIncident: false };
  });
}

type AlertIncidentContext = {
  openIncident: schema.Incident | null;
  previousIncident: schema.Incident | null;
};

async function loadAlertIncidentContext(
  issue: schema.Issue,
  deps: IntakeDeps,
): Promise<AlertIncidentContext | null> {
  const episode = await deps.repo.findAlertEpisodeForIssue(issue.id);
  if (!episode) return null;
  const open = await deps.repo.findOpenIncidentForAlert(episode.alertId, episode.groupKey);
  if (open) return { openIncident: open, previousIncident: null };
  const latest = await deps.repo.findLatestIncidentForAlert(episode.alertId, episode.groupKey);
  if (!latest) return { openIncident: null, previousIncident: null };
  // Episodes keep pointing at the incident they originally drove; a merged
  // incident's live row is the survivor at the end of the merge chain.
  const live = await followMergeChain(latest, deps);
  if (live.status === "open") return { openIncident: live, previousIncident: null };
  return { openIncident: null, previousIncident: live };
}

async function followMergeChain(
  incident: schema.Incident,
  deps: IntakeDeps,
): Promise<schema.Incident> {
  let current = incident;
  const seen = new Set<string>([current.id]);
  while (current.status === "merged" && current.mergedIntoId && !seen.has(current.mergedIntoId)) {
    const next = await deps.repo.findIncident(current.mergedIntoId);
    if (!next) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

async function findMatchingIncident(issue: schema.Issue, deps: IntakeDeps): Promise<Grouping> {
  const heuristic = await findHeuristicMatchingIncident(issue, deps);
  if (heuristic) {
    return { match: heuristic, standaloneSource: null, standaloneReason: null, failedReason: null };
  }
  // Same request = same incident: join an open incident that shares this
  // issue's trace id (a span exception and its own log line, or several logs
  // from one failed request) before spending an LLM call. Cross-service, since
  // the span and its Vercel-drained log arrive under different service names.
  const sameTrace = await findSameTraceMatchingIncident(issue, deps);
  if (sameTrace) {
    return { match: sameTrace, standaloneSource: null, standaloneReason: null, failedReason: null };
  }
  // Alert-episode issues go through LLM grouping like errors do: a breach can
  // be another manifestation of an incident opened by errors (or vice versa).
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

async function findSameTraceMatchingIncident(
  issue: schema.Issue,
  deps: IntakeDeps,
): Promise<IncidentMatch | null> {
  // No trace id ⇒ nothing to match on. Bail before the candidate/linked reads
  // so no-trace intakes (e.g. alert episodes) don't do them here only for the
  // LLM path to immediately repeat them.
  if (!issueSample(issue)?.traceId) return null;
  const candidates = await deps.repo.findOpenIncidentCandidates(issue, { filterService: false });
  if (candidates.length === 0) return null;
  const linked = await deps.repo.loadLinkedIncidentIssues(candidates);
  return findSameTraceIncidentMatch(issue, candidates, linked);
}

async function findLlmMatchingIncident(issue: schema.Issue, deps: IntakeDeps): Promise<Grouping> {
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

  // This runs outside the serialized create section, so concurrent duplicates
  // of the same issue can all reach it. Guard the marker with onlyIfUndecided
  // so a racer that arrives after the winner already recorded its verdict
  // (grouped/standalone, non-null source) can't overwrite it with 'pending'.
  await deps.repo.updateIssueGrouping(issue.id, {
    state: "pending",
    source: "llm",
    reason: "Waiting for LLM grouping.",
    incrementAttempt: true,
    onlyIfUndecided: true,
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
  // Set by the losing concurrent-intake racer: apply only if the issue is
  // still 'pending' so it clears its own leftover marker without clobbering
  // the winner's recorded verdict.
  opts?: { onlyIfPending?: boolean },
): Promise<void> {
  const onlyIfPending = opts?.onlyIfPending;
  if (grouping.match) {
    await repo.updateIssueGrouping(issueId, {
      state: "grouped",
      source: grouping.match.source,
      reason: grouping.match.reason,
      onlyIfPending,
    });
    return;
  }
  if (grouping.failedReason) {
    await repo.updateIssueGrouping(issueId, {
      state: "failed",
      source: "llm",
      reason: grouping.failedReason,
      onlyIfPending,
    });
    return;
  }
  await repo.updateIssueGrouping(issueId, {
    state: "standalone",
    source: grouping.standaloneSource,
    reason: grouping.standaloneReason,
    onlyIfPending,
  });
}
