import {
  QUIET_INCIDENT_PERIOD_MS,
  type QuietIncidentCandidate,
  decideQuietIncidentResolution,
} from "./domain.js";
import { buildQuietIncidentResolvedSlackMessage } from "./slack-message.js";

export type QuietIncidentResolveResult =
  | {
      kind: "resolved";
      linkedIssueCount: number;
      quietSince: Date;
      resolutionProof: { agentRunId: string | null; eventDedupeKey: string };
    }
  | { kind: "disabled" | "not_open" | "no_linked_issues" | "recent_recurrence" };

export type QuietIncidentResolutionSweepDeps = {
  now(): Date;
  listCandidates(cutoff: Date): Promise<QuietIncidentCandidate[]>;
  resolveIfStillQuiet(input: {
    incidentId: string;
    cutoff: Date;
    resolvedAt: Date;
  }): Promise<QuietIncidentResolveResult>;
  closeOpenPullRequests(input: {
    incidentId: string;
    resolutionProof: { agentRunId: string | null; eventDedupeKey: string };
  }): Promise<void>;
  postSlackNotification(input: { incidentId: string; message: string }): Promise<void>;
  logger: {
    error(obj: Record<string, unknown>, message: string): void;
  };
};

export async function runQuietIncidentResolutionSweep(
  deps: QuietIncidentResolutionSweepDeps,
): Promise<number> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - QUIET_INCIDENT_PERIOD_MS);
  const candidates = await deps.listCandidates(cutoff);
  let resolvedCount = 0;

  for (const candidate of candidates) {
    const decision = decideQuietIncidentResolution(candidate, now);
    if (decision.kind !== "resolve") continue;

    try {
      const result = await deps.resolveIfStillQuiet({
        incidentId: candidate.incidentId,
        cutoff,
        resolvedAt: now,
      });
      if (result.kind !== "resolved") continue;
      resolvedCount += 1;
      await deps.closeOpenPullRequests({
        incidentId: candidate.incidentId,
        resolutionProof: result.resolutionProof,
      });
      await deps.postSlackNotification({
        incidentId: candidate.incidentId,
        message: buildQuietIncidentResolvedSlackMessage(result),
      });
    } catch (err) {
      deps.logger.error(
        {
          scope: "quiet-incident-resolution",
          incident_id: candidate.incidentId,
          err: err instanceof Error ? err.message : String(err),
        },
        "quiet incident resolution failed",
      );
    }
  }

  return resolvedCount;
}
