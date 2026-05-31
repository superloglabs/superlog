import type { schema } from "@superlog/db";
import { meetsConfidence } from "./policy.js";

// One fingerprint signature per issue linked to the incident. Used by the
// metrics repo to scope CH queries to events that actually belong to this
// incident, instead of every exception on the service.
export type IssueSignature = {
  exceptionType: string;
};

export type CandidateIncident = {
  id: string;
  projectId: string;
  title: string;
  codename: string;
  service: string | null;
  firstSeen: Date;
  lastSeen: Date;
  issueCount: number;
  issueSignatures: IssueSignature[];
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackInstallationId: string | null;
};

// Output of the agent's terminal `propose_resolution` tool. Mirrors the
// JSONSchema declared in tools.ts.
export type ProposalToolInput = {
  looks_resolved: boolean;
  confidence: schema.IncidentResolutionProposalConfidence;
  reason_code: string;
  reason_text: string;
  evidence_summary?: string;
};

export type ProposalOutcome =
  | { kind: "propose"; proposal: ProposalToolInput }
  | { kind: "skip_not_resolved"; proposal: ProposalToolInput }
  | { kind: "skip_below_confidence"; proposal: ProposalToolInput };

// Given a parsed proposal from the agent, decide what the orchestrator
// should do. Pure, so the tick path can be tested without an LLM.
export function decideProposalOutcome(
  proposal: ProposalToolInput,
  minConfidence: schema.IncidentResolutionProposalConfidence,
): ProposalOutcome {
  if (!proposal.looks_resolved) return { kind: "skip_not_resolved", proposal };
  if (!meetsConfidence(proposal.confidence, minConfidence)) {
    return { kind: "skip_below_confidence", proposal };
  }
  return { kind: "propose", proposal };
}

// Parser used to validate the structured tool output. Stays in the domain
// because the shape is part of the autorecovery contract — when this
// changes, the agent prompt and the proposals table change in lockstep.
export function parseProposalToolInput(input: unknown): ProposalToolInput | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.looks_resolved !== "boolean") return null;
  if (
    obj.confidence !== "low" &&
    obj.confidence !== "medium" &&
    obj.confidence !== "high"
  ) {
    return null;
  }
  if (typeof obj.reason_code !== "string" || !obj.reason_code.trim()) return null;
  if (typeof obj.reason_text !== "string" || !obj.reason_text.trim()) return null;
  return {
    looks_resolved: obj.looks_resolved,
    confidence: obj.confidence,
    reason_code: obj.reason_code.trim(),
    reason_text: obj.reason_text.trim(),
    evidence_summary:
      typeof obj.evidence_summary === "string" ? obj.evidence_summary.trim() : undefined,
  };
}

const MIN_LOOKBACK_HOURS = 1;
const MAX_LOOKBACK_HOURS = 168;
const DEFAULT_LOOKBACK_HOURS = 24;

export function clampLookbackHours(input: unknown): number {
  if (!input || typeof input !== "object") return DEFAULT_LOOKBACK_HOURS;
  const h = (input as { hours?: unknown }).hours;
  if (typeof h !== "number" || !Number.isFinite(h)) return DEFAULT_LOOKBACK_HOURS;
  return Math.max(MIN_LOOKBACK_HOURS, Math.min(MAX_LOOKBACK_HOURS, Math.floor(h)));
}

export function buildInitialUserMessage(
  incident: CandidateIncident,
  now: Date,
): string {
  const hoursSinceLastSeen = Math.floor(
    (now.getTime() - incident.lastSeen.getTime()) / (60 * 60 * 1000),
  );
  return [
    "Incident under review:",
    JSON.stringify(
      {
        incidentId: incident.id,
        codename: incident.codename,
        title: incident.title,
        service: incident.service,
        issueCount: incident.issueCount,
        firstSeen: incident.firstSeen.toISOString(),
        lastSeen: incident.lastSeen.toISOString(),
        hoursSinceLastSeen,
      },
      null,
      2,
    ),
    "",
    "Use the tools to inspect the underlying signal, then call propose_resolution.",
  ].join("\n");
}

const CONFIDENCE_LABEL: Record<schema.IncidentResolutionProposalConfidence, string> = {
  low: "low confidence",
  medium: "medium confidence",
  high: "high confidence",
};

export function buildProposalSlackBlocks(
  proposalId: string,
  proposal: ProposalToolInput,
): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `:white_check_mark: *This incident looks resolved* (${CONFIDENCE_LABEL[proposal.confidence]}).`,
          proposal.reason_text,
          `_Reason: \`${proposal.reason_code}\`_`,
        ].join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Confirm resolved" },
          style: "primary",
          action_id: `resolve_proposal_confirm:${proposalId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✖ Dismiss" },
          action_id: `resolve_proposal_dismiss:${proposalId}`,
        },
      ],
    },
  ];
}

export function buildProposalSlackText(proposal: ProposalToolInput): string {
  return `:white_check_mark: This incident looks resolved — ${proposal.reason_text}`;
}
