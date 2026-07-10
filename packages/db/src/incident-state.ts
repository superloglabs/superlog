import type * as schema from "./schema.js";

export const INCIDENT_ACTIVE_STATES: readonly schema.IncidentStatus[] = ["open"] as const;
export const INCIDENT_CLOSED_STATES: readonly schema.IncidentStatus[] = [
  "resolved",
  "autoresolved_noise",
  "merged",
] as const;

export function isActiveIncidentState(state: schema.IncidentStatus | string): boolean {
  return (INCIDENT_ACTIVE_STATES as readonly string[]).includes(state);
}

export class IllegalIncidentTransitionError extends Error {
  constructor(method: string, from: string, allowedFrom: readonly schema.IncidentStatus[]) {
    super(
      `${method}: cannot transition incident from "${from}"; allowed source states: ${allowedFrom.join(", ")}`,
    );
    this.name = "IllegalIncidentTransitionError";
  }
}

export function assertIncidentSourceState(
  method: string,
  current: schema.IncidentStatus | string,
  allowed: readonly schema.IncidentStatus[],
): void {
  if (!(allowed as readonly string[]).includes(current)) {
    throw new IllegalIncidentTransitionError(method, current, allowed);
  }
}

export type AgentRunIncidentPatch = {
  updates: Partial<schema.Incident>;
  noiseReason: schema.IncidentNoiseReason | null;
  noiseResolved: boolean;
};

export function buildAgentRunIncidentPatch(opts: {
  incident: schema.Incident;
  result: schema.AgentRunResult;
  agentRunId: string;
  titleMaxLength?: number;
  now?: Date;
}): AgentRunIncidentPatch {
  const result = opts.result;
  const titleMaxLength = opts.titleMaxLength ?? 200;
  const proposed = result.proposedTitle?.trim();
  const updates: Partial<schema.Incident> = {};

  if (proposed && proposed !== opts.incident.title) {
    updates.title = proposed.slice(0, titleMaxLength);
  }
  if (result.severity && result.severity !== opts.incident.severity) {
    updates.severity = result.severity;
  }

  // Findings land on the incident both when the run concludes and when it
  // parks on awaiting_events (PRs out for review) — the dashboard should show
  // what the investigation found while it waits.
  if (result.state === "complete" || result.state === "awaiting_events") {
    updates.agentSummary = result.summary ?? null;
    updates.rootCauseText = result.rootCause?.text ?? null;
    updates.rootCauseConfidence = result.rootCause?.confidence ?? null;
    updates.estimatedImpactText = result.estimatedImpact?.text ?? null;
    updates.estimatedImpactConfidence = result.estimatedImpact?.confidence ?? null;
    updates.suggestedSeverity = result.severity ?? null;
    updates.noiseClassification = result.noiseClassification ?? null;
    updates.resolutionClassification = result.resolutionClassification ?? null;
    updates.findingsAgentRunId = opts.agentRunId;
  }

  // A noise verdict no longer gets its own incident status: the caller
  // resolves the incident plainly (resolveIncident with the noise reason as
  // the reason code) and applies the verdict's action to the linked issues —
  // silence or observe. The noise columns stay as the record of the verdict.
  // Recurrence of a resolved issue opens a NEW incident (chained via
  // previous_incident_id) rather than reopening this one, so nothing here
  // needs a reopen-on-regression carve-out anymore.
  const noiseReason =
    result.state === "complete" && opts.incident.status === "open"
      ? (result.noiseClassification?.reason ?? null)
      : null;
  if (noiseReason) {
    updates.noiseReason = noiseReason;
    updates.noiseResolvedAt = opts.now ?? new Date();
  }

  return { updates, noiseReason, noiseResolved: !!noiseReason };
}

export function buildManualReopenPatch(): Partial<schema.Incident> {
  return {
    status: "open",
    resolvedAt: null,
    resolvedByKind: null,
    resolvedByUserId: null,
    resolvedBySlackUserId: null,
    resolvedReasonCode: null,
    resolvedReasonText: null,
    noiseReason: null,
    noiseResolvedAt: null,
    mergedIntoId: null,
    mergedAt: null,
    autoInvestigateSuppressedUntil: null,
  };
}
