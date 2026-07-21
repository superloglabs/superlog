// Per-outcome tool contract for investigation agent runs.
//
// The contract has two tiers:
//   - `report_findings` (non-terminal): shared metadata, callable repeatedly.
//   - Terminal tools: every successful call ends the turn. `propose_pr` and
//     `resolve_incident` are dispatched server-side before their final ack so
//     delivery/validation failures can be corrected in the same turn. The
//     other terminal tools are pure outcomes collected by the runner.
//
// Each tool has a flat JSON schema (top-level `type`/`properties`/`required`
// only — some runner APIs reject composition keywords like `oneOf`/`allOf` at
// the top level of a custom tool's input_schema, and a rejected schema blocks
// every run at agent-create time). Schemas are not enforced server-side by
// every runner, so `validateOutcomeToolInput` re-validates each call
// worker-side; its error strings are written for the model, which sees them
// as tool errors and can correct the call within the same session.
//
// `assembleAgentRunResult` folds the merged findings and terminal call into
// the persisted `AgentRunResult` shape.

import type {
  AgentRunIncidentResolution,
  AgentRunIssueClassification,
  AgentRunMobileRegressionTest,
  AgentRunPr,
  AgentRunResult,
  IncidentSeverity,
  IssueEscalationTrigger,
} from "@superlog/db";

export type OutcomeToolSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
};

export type OutcomeToolDefinition = {
  name: string;
  description: string;
  input_schema: OutcomeToolSchema;
};

export const REPORT_FINDINGS_TOOL_NAME = "report_findings";

// Terminal tools whose success depends on a server-side operation. They are
// acked only after the operation succeeds; an error ack keeps the turn active.
export const DISPATCHED_OUTCOME_TOOL_NAMES = ["propose_pr", "resolve_incident"] as const;

export const TERMINAL_OUTCOME_TOOL_NAMES = [
  "propose_pr",
  "create_linear_issue",
  "complete_investigation",
  "ask_human",
  "report_external_cause",
  "resolve_incident",
] as const;

export type TerminalOutcomeToolName = (typeof TERMINAL_OUTCOME_TOOL_NAMES)[number];

// Tools retired from the contract. Sessions created against an old toolset
// can outlive a deploy (a parked run resumes days later), so a call to one of
// these must be error-acked with redirect guidance — not routed to the
// unknown-tool path, which hard-fails the run.
export const RETIRED_OUTCOME_TOOL_NAMES = [
  "report_failure",
  "mark_already_resolved",
  "silence_as_noise",
  "place_under_observation",
  "resolve_issue",
] as const;

export type RetiredOutcomeToolName = (typeof RETIRED_OUTCOME_TOOL_NAMES)[number];

export type DispatchedOutcomeToolName = (typeof DISPATCHED_OUTCOME_TOOL_NAMES)[number];

export const OUTCOME_TOOL_NAMES = [
  REPORT_FINDINGS_TOOL_NAME,
  ...TERMINAL_OUTCOME_TOOL_NAMES,
] as const;

// First line of the worker's one-shot "conclude your turn" steer (the full
// prompt lives with the sync loop). It doubles as the machine-readable way to
// recognize that steer in a session's own event stream — the sync loop uses
// it to skip redelivering the nudge, and stream-replaying runner backends use
// it to exempt the nudge from turn-boundary handling: unlike a human reply or
// a context delta, the nudge carries no new information, so it must never
// reset (and thereby discard) outcome state the turn already produced. The
// wording must stay stable; live sessions can carry an already-delivered
// nudge across a deploy.
export const TERMINAL_OUTCOME_NUDGE_MARKER =
  "You ended your turn without concluding the investigation, so it has no recorded outcome and nothing is pending.";

export function isDispatchedOutcomeToolName(name: string): name is DispatchedOutcomeToolName {
  return (DISPATCHED_OUTCOME_TOOL_NAMES as readonly string[]).includes(name);
}

export function isRetiredOutcomeToolName(name: string): name is RetiredOutcomeToolName {
  return (RETIRED_OUTCOME_TOOL_NAMES as readonly string[]).includes(name);
}

export function isTerminalOutcomeToolName(name: string): name is TerminalOutcomeToolName {
  return (TERMINAL_OUTCOME_TOOL_NAMES as readonly string[]).includes(name);
}

const SEVERITIES: IncidentSeverity[] = ["SEV-1", "SEV-2", "SEV-3"];

const ESCALATE_ON = ["events_per_minute", "additional_events"] as const;

const MOBILE_TEST_STATUSES = ["created", "skipped", "not_applicable"] as const;

const EVIDENCE_FORMAT =
  "Cite evidence as a bold path:line header followed by a fenced code block with the language tag matching the file extension, quoting the file verbatim.";

// ---------------------------------------------------------------------------
// Findings (shared metadata, non-terminal)
// ---------------------------------------------------------------------------

export type AgentRunFindings = {
  summary: string;
  proposedTitle?: string | null;
  rootCause?: string | null;
  rootCauseConfidence?: number | null;
  estimatedImpact?: string | null;
  impactConfidence?: number | null;
  severity?: IncidentSeverity | null;
  handoffNotes?: string | null;
};

const REPORT_FINDINGS_DEFINITION: OutcomeToolDefinition = {
  name: REPORT_FINDINGS_TOOL_NAME,
  description:
    "Record what the investigation found. Call this before any classification, PR, or resolution tool; call it again to revise — include `summary` on every call (repeat the current one when it hasn't changed); every other field overwrites its previous value when provided and is kept when omitted.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "1-2 short sentences (prefer one) describing what is happening from the operator's perspective. Lead with the specific product/workflow surface that is failing — the named thing a teammate would point to on a whiteboard ('Stripe webhook delivery', 'the signup webhook handler'), not just the service/repo or a generic noun. Say the visible failure before the mechanism, in plain English ('retries fail', 'is logged as ERROR'), never leading with a function name, file path, exception class, or constraint name. Do not paraphrase proposedTitle — add one useful evidence-backed fact beyond it: bounded scope/count/window, user impact, expected/no-impact, recovery state, or sequencing. No speculative impact claims ('likely impacting all jobs') without telemetry. Remediation wording ('the fix…', 'the patch…') is banned here — it belongs in rootCause or the PR body. Good: 'Expired Clerk JWTs return the expected 401, but are logged as ERROR and create noisy incidents.' Bad: 'execute_step: missing idempotency guard causes UniqueViolationError on retries.'",
      },
      proposedTitle: {
        type: "string",
        description:
          "Replacement incident title, 40-65 chars: affected product surface + plain-English symptom, symptom-first, never the fix. When a user-visible error string exists, use it instead of raw status codes ('Unauthorized' over '403'), and translate raw error codes/exception classes into symptom words ('connection drops' over 'ECONNRESET'; 'unique constraint' over 'UniqueViolationError') — raw codes belong in rootCause, not the title. No imperative verbs (Allow/Fix/Handle), no function names, no file paths. Good: 'Routine Clerk JWT expiry is logged as ERROR'; 'Alert evaluation fails due to ClickHouse connection drops'. Bad: 'Alert evaluation fails on transient ClickHouse ECONNRESET'; 'execute_step: missing idempotency guard causes UniqueViolationError'. For noise verdicts, frame the title as the false positive itself ('False-positive ERROR logs on Slack reaction adds for re-delivered order updates'), not as the underlying third-party code. Omit only if you have nothing better than the current title.",
      },
      rootCause: {
        type: "string",
        description: `Markdown root-cause analysis. You earn confidence by quoting hard evidence: ${EVIDENCE_FORMAT} Include commit SHAs, log/trace IDs you actually verified. Mechanism detail, code behavior, and implementation phrasing all belong here, not in summary/proposedTitle.`,
      },
      rootCauseConfidence: {
        type: "integer",
        minimum: 0,
        maximum: 10,
        description:
          "0-10. 10 = every claim backed by a verbatim quote from a file read this session AND you observed/reproduced the failure; 7-9 = quote-backed, reproduction inferred; 4-6 = code path identified, mechanism is hypothesis; 1-3 = speculative; 0 = no evidence (prefer ask_human then).",
      },
      estimatedImpact: {
        type: "string",
        description:
          "1-3 sentences: what the affected component is supposed to do and the inferred user/business impact.",
      },
      impactConfidence: {
        type: "integer",
        minimum: 0,
        maximum: 10,
        description:
          "0-10. 10 = impact backed by concrete signal (telemetry counts, error rates, traffic numbers from a tool call); low = inferred from the component name alone.",
      },
      severity: {
        type: "string",
        enum: SEVERITIES,
        description:
          "Calibrated guess. SEV-1 = customer-visible outage / data loss / revenue stop. SEV-2 = significant degradation, major feature broken for many users. SEV-3 = bug or partial impact not blocking primary flows. Omit if you genuinely cannot tell.",
      },
      handoffNotes: {
        type: "string",
        description:
          "5-15 markdown lines for a future follow-up turn on this incident (triggered by a PR comment or user reply after this session is gone): files/areas examined, hypotheses ruled out with the evidence that ruled them out, repo gotchas (build quirks, test setup), open uncertainties. Do not repeat rootCause — this is for what is NOT captured elsewhere.",
      },
    },
    required: ["summary"],
  },
};

// ---------------------------------------------------------------------------
// Terminal tools
// ---------------------------------------------------------------------------

export type PullRequestProposal = {
  repoFullName: string;
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  patchFilePath: string;
  changedFiles?: string[];
  mobileTestStatus?: (typeof MOBILE_TEST_STATUSES)[number];
  mobileTestId?: string;
  mobileTestReason?: string;
};

export type ProposePrPayload = {
  pullRequests: PullRequestProposal[];
};

const PULL_REQUEST_PROPERTIES = {
  repoFullName: {
    type: "string",
    description: "owner/repo of the mounted repository this patch targets.",
  },
  title: {
    type: "string",
    description:
      "Exact PR title for human review: '[superlog] <imperative fix summary>' describing the fix outcome, not the incident title.",
  },
  body: {
    type: "string",
    description:
      "Review-ready markdown. Default shape: '# Summary', one paragraph for the user-visible symptom, one for the root-cause mechanism in plain English, one for the remediation direction, then a final incident link. Follow the org PR template instead when one is provided.",
  },
  branchName: {
    type: "string",
    pattern: "^superlog/",
    description:
      "Must start with 'superlog/' followed by a short kebab-case slug. Reuse a branch name to push to that PR.",
  },
  baseBranch: {
    type: "string",
    description: "The branch the PR should target (the repo's active development branch).",
  },
  patchFilePath: {
    type: "string",
    description:
      "A distinct unified diff under /mnt/session/outputs/ containing changes only for this repository.",
  },
  changedFiles: {
    type: "array",
    items: { type: "string" },
    description: "Repo-relative paths the patch touches.",
  },
  mobileTestStatus: {
    type: "string",
    enum: MOBILE_TEST_STATUSES,
    description:
      "Only for orgs with a mobile-regression integration: whether a regression test was created, skipped, or not applicable.",
  },
  mobileTestId: { type: "string", description: "The created mobile regression test id." },
  mobileTestReason: {
    type: "string",
    description: "Why the mobile regression test was skipped / not applicable.",
  },
};

const PULL_REQUEST_REQUIRED = [
  "repoFullName",
  "title",
  "body",
  "branchName",
  "baseBranch",
  "patchFilePath",
];

const PROPOSE_PR_DEFINITION: OutcomeToolDefinition = {
  name: "propose_pr",
  description:
    "Terminal for this turn: open or update one validated PR per repository, then wait for review. Pass a non-empty pullRequests array; every repository and patchFilePath must be unique. Each patch must be a unified diff under /mnt/session/outputs/ that changes only its repository. A new branchName opens a PR; reusing the same repository and branchName pushes a follow-up commit. If validation or delivery fails, the call is rejected and the turn stays active so you can retry only failed entries. NOT for noise: a patch that only quiets a signal is the wrong outcome. Do not call resolve_incident in the same turn; the incident stays open until the PR lifecycle resumes the session.",
  input_schema: {
    type: "object",
    properties: {
      pullRequests: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: PULL_REQUEST_PROPERTIES,
          required: PULL_REQUEST_REQUIRED,
        },
        description:
          "One validated PR proposal per repository. Pass an actual JSON array, not JSON-encoded text.",
      },
    },
    required: ["pullRequests"],
  },
};

export type IssueOutcomeStatus = "resolved" | "silenced" | "under_observation";

type ResolveIncidentIssueOutcomeBase = {
  issueId: string;
  reason: string;
  evidence: string;
};

export type ResolveIncidentIssueOutcome = ResolveIncidentIssueOutcomeBase &
  (
    | {
        status: Exclude<IssueOutcomeStatus, "under_observation">;
        escalateOn?: never;
        threshold?: never;
      }
    | {
        status: "under_observation";
        escalateOn: (typeof ESCALATE_ON)[number];
        threshold: number;
      }
  );

export type ResolveIncidentPayload = {
  reason: string;
  evidence: string;
  issueOutcomes: ResolveIncidentIssueOutcome[];
};

const RESOLVE_INCIDENT_DEFINITION: OutcomeToolDefinition = {
  name: "resolve_incident",
  description:
    "Terminal: resolve the Incident only when everything required has been done and impact has ceased, or when no remediation is needed. Include exactly one outcome for every linked Issue. Error Issues may be resolved, silenced, or placed under observation; alert-episode Issues must be resolved. The platform validates and applies all Issue outcomes and the Incident resolution atomically. If any entry is invalid, nothing changes and the turn stays active. Do not resolve while waiting for an open PR; propose_pr ends that turn instead.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Free text: why the incident is resolved, in one plain-English sentence an operator can read in a list.",
      },
      evidence: {
        type: "string",
        description: `1-3 sentences citing the evidence that the impact has ceased (before/after signal + window when telemetry is the proof). ${EVIDENCE_FORMAT}`,
      },
      issueOutcomes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            status: {
              type: "string",
              enum: ["resolved", "silenced", "under_observation"],
            },
            reason: { type: "string" },
            evidence: { type: "string" },
            escalateOn: { type: "string", enum: ESCALATE_ON },
            threshold: { type: "integer", minimum: 1 },
          },
          required: ["issueId", "status", "reason", "evidence"],
        },
        description: "Exactly one outcome for every Issue linked to the Incident.",
      },
    },
    required: ["reason", "evidence", "issueOutcomes"],
  },
};

export type ReportExternalCausePayload = {
  cause: string;
  source: string;
  evidence: string;
  recommendedNextStep: string;
};

const REPORT_EXTERNAL_CAUSE_DEFINITION: OutcomeToolDefinition = {
  name: "report_external_cause",
  description:
    "Terminal: report an established root cause outside the systems available for remediation. This ends the turn and leaves the Incident and every linked Issue open while the session waits for an external change or human update. Use ask_human instead when a concrete answer or decision is needed.",
  input_schema: {
    type: "object",
    properties: {
      cause: {
        type: "string",
        description: "Concise explanation of the established external root cause.",
      },
      source: {
        type: "string",
        description: "The external provider, service, or customer-owned system responsible.",
      },
      evidence: {
        type: "string",
        description: "Evidence proving the cause is external and produces the observed impact.",
      },
      recommendedNextStep: {
        type: "string",
        description: "The action an external owner should take or the condition to wait for.",
      },
    },
    required: ["cause", "source", "evidence", "recommendedNextStep"],
  },
};

export type AskHumanPayload = { question: string };

export type CompleteInvestigationPayload = Record<string, never>;

export type CreateLinearIssuePayload = Record<string, never>;

const CREATE_LINEAR_ISSUE_DEFINITION: OutcomeToolDefinition = {
  name: "create_linear_issue",
  description:
    "Terminal: create or reuse exactly one Linear issue for this investigation from the recorded findings, then complete the run while leaving the Incident open. Use this after report_findings when a human asks for a Linear issue or the findings need an explicit Linear handoff. The platform performs the Linear mutation idempotently; do not try to call Linear directly.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const COMPLETE_INVESTIGATION_DEFINITION: OutcomeToolDefinition = {
  name: "complete_investigation",
  description:
    "Terminal: finish the investigation and hand the recorded findings to the configured external ticket workflow, while leaving the incident open. Use this only after report_findings when no PR or approval action is available. This does not resolve the incident and does not require every linked issue to be classified.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const ASK_HUMAN_DEFINITION: OutcomeToolDefinition = {
  name: "ask_human",
  description:
    "Terminal: a human must act or answer before this investigation can continue; the run pauses until they reply, then resumes with your session intact. Use it when: (1) you need specific missing context (expected behavior, a suspected owner, a recent deploy, a repro hint) — ask for the specific thing and include the best leads you checked; (2) you diagnosed the problem but the remediation is not yours to make (third-party library defect, provider quota, config the customer owns, or a decision needed between remediation paths) — state the diagnosis, then ask the concrete question whose answer unblocks action, naming the options if there are several; (3) you genuinely could not locate the failing code path — say what you searched and ask for the pointer you are missing; (4) telemetry names a concrete code artifact (file path, function, exception class, endpoint) absent from every mounted repo at HEAD and across remote branches — quote the missing artifact, name the repos you searched, and ask which repo owns the code (more repos exist than were mounted into this session). Never fabricate a question to avoid a harder outcome you have the evidence for.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The specific question a human must answer for you to continue.",
      },
    },
    required: ["question"],
  },
};

export const OUTCOME_TOOL_DEFINITIONS: OutcomeToolDefinition[] = [
  REPORT_FINDINGS_DEFINITION,
  PROPOSE_PR_DEFINITION,
  ASK_HUMAN_DEFINITION,
  REPORT_EXTERNAL_CAUSE_DEFINITION,
  RESOLVE_INCIDENT_DEFINITION,
];

export type AgentInterventionCapabilities = {
  prCreation: boolean;
  approvalPrompts: boolean;
  linearTicketCreation: boolean;
};

export function hasInterventionTools(capabilities: AgentInterventionCapabilities): boolean {
  return capabilities.prCreation || capabilities.approvalPrompts;
}

export function outcomeToolDefinitionsForCapabilities(
  capabilities: AgentInterventionCapabilities,
): OutcomeToolDefinition[] {
  return [
    REPORT_FINDINGS_DEFINITION,
    ...(capabilities.prCreation ? [PROPOSE_PR_DEFINITION] : []),
    ...(capabilities.linearTicketCreation ? [CREATE_LINEAR_ISSUE_DEFINITION] : []),
    ...(!hasInterventionTools(capabilities) && !capabilities.linearTicketCreation
      ? [COMPLETE_INVESTIGATION_DEFINITION]
      : []),
    ASK_HUMAN_DEFINITION,
    REPORT_EXTERNAL_CAUSE_DEFINITION,
    RESOLVE_INCIDENT_DEFINITION,
  ];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type TerminalOutcome =
  | { name: "propose_pr"; payload: ProposePrPayload }
  | { name: "create_linear_issue"; payload: CreateLinearIssuePayload }
  | { name: "complete_investigation"; payload: CompleteInvestigationPayload }
  | { name: "ask_human"; payload: AskHumanPayload }
  | { name: "report_external_cause"; payload: ReportExternalCausePayload }
  | { name: "resolve_incident"; payload: ResolveIncidentPayload };

type ValidatedTerminalOutcome = TerminalOutcome extends infer Outcome
  ? Outcome extends TerminalOutcome
    ? { ok: true; tool: Outcome["name"]; payload: Outcome["payload"] }
    : never
  : never;

export type ValidateOutcome =
  | { ok: true; tool: "report_findings"; payload: AgentRunFindings }
  | ValidatedTerminalOutcome
  | { ok: false; errors: string[] };

export type LegacySilenceAsNoisePayload = {
  issueId: string;
  reason: string;
  evidence: string;
};

export type LegacyPlaceUnderObservationPayload = LegacySilenceAsNoisePayload & {
  escalateOn: (typeof ESCALATE_ON)[number];
  threshold: number;
};

export type LegacyResolveIssuePayload = LegacySilenceAsNoisePayload;

export type LegacyResolveIncidentPayload = Pick<ResolveIncidentPayload, "reason" | "evidence">;

export type ValidatedLegacyOutcome =
  | { ok: true; tool: "resolve_incident"; payload: LegacyResolveIncidentPayload }
  | { ok: false; errors: string[] };

// Tools that conclude with findings humans will read — these refuse to run
// until report_findings has been called.
const FINDINGS_REQUIRED = new Set<string>([
  "propose_pr",
  "resolve_incident",
  "create_linear_issue",
  "complete_investigation",
  "report_external_cause",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function pushRequiredString(
  errors: string[],
  input: Record<string, unknown>,
  key: string,
): string | null {
  const v = input[key];
  if (typeof v === "string" && v.trim().length > 0) return v;
  errors.push(`\`${key}\` is required and must be a non-empty string.`);
  return null;
}

function optionalString(
  errors: string[],
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  errors.push(`\`${key}\` must be a string when provided; you sent ${JSON.stringify(v)}.`);
  return undefined;
}

function optionalClampedConfidence(
  errors: string[],
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`\`${key}\` must be an integer 0-10; you sent ${JSON.stringify(v)}.`);
    return undefined;
  }
  // Clamp instead of reject — models occasionally overshoot the range.
  return Math.max(0, Math.min(10, Math.round(v)));
}

function requiredEnum<T extends string>(
  errors: string[],
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const v = input[key];
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  errors.push(
    `\`${key}\` must be one of ${allowed.map((a) => `"${a}"`).join(", ")}; you sent ${JSON.stringify(v)}.`,
  );
  return null;
}

function optionalStringArray(
  errors: string[],
  input: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v) && v.every((item) => typeof item === "string")) return v as string[];
  errors.push(`\`${key}\` must be an array of strings when provided.`);
  return undefined;
}

function validatePullRequestProposal(
  raw: unknown,
  index: number,
): { payload: PullRequestProposal | null; errors: string[] } {
  if (!isRecord(raw)) {
    return {
      payload: null,
      errors: [`\`pullRequests[${index}]\` must be an object.`],
    };
  }
  const errors: string[] = [];
  const prefix = `pullRequests[${index}]`;
  const required = (key: string): string | null => {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value;
    errors.push(`\`${prefix}.${key}\` is required and must be a non-empty string.`);
    return null;
  };
  const repoFullName = required("repoFullName");
  const title = required("title");
  const body = required("body");
  const branchName = required("branchName");
  const baseBranch = required("baseBranch");
  const patchFilePath = required("patchFilePath");
  if (branchName && !branchName.startsWith("superlog/")) {
    errors.push(`\`${prefix}.branchName\` must start with \`superlog/\`.`);
  }
  if (patchFilePath && !patchFilePath.startsWith("/mnt/session/outputs/")) {
    errors.push(`\`${prefix}.patchFilePath\` must be under \`/mnt/session/outputs/\`.`);
  }
  if (raw.validationPassed === false) {
    errors.push(
      `\`${prefix}.validationPassed\` is false. Fix and validate the patch before proposing it.`,
    );
  }
  const changedFiles = optionalStringArray(errors, raw, "changedFiles");
  let mobileTestStatus: PullRequestProposal["mobileTestStatus"];
  if (raw.mobileTestStatus !== undefined && raw.mobileTestStatus !== null) {
    mobileTestStatus =
      requiredEnum(errors, raw, "mobileTestStatus", MOBILE_TEST_STATUSES) ?? undefined;
  }
  const mobileTestId = optionalString(errors, raw, "mobileTestId");
  const mobileTestReason = optionalString(errors, raw, "mobileTestReason");
  if (mobileTestStatus === "created" && !mobileTestId) {
    errors.push(`\`${prefix}.mobileTestId\` is required when mobileTestStatus is "created".`);
  }
  if (
    (mobileTestStatus === "skipped" || mobileTestStatus === "not_applicable") &&
    !mobileTestReason
  ) {
    errors.push(
      `\`${prefix}.mobileTestReason\` is required when mobileTestStatus is "${mobileTestStatus}".`,
    );
  }
  if (errors.length > 0) return { payload: null, errors };
  const payload: PullRequestProposal = {
    repoFullName: repoFullName as string,
    title: title as string,
    body: body as string,
    branchName: branchName as string,
    baseBranch: baseBranch as string,
    patchFilePath: patchFilePath as string,
  };
  if (changedFiles) payload.changedFiles = changedFiles;
  if (mobileTestStatus) payload.mobileTestStatus = mobileTestStatus;
  if (mobileTestId) payload.mobileTestId = mobileTestId;
  if (mobileTestReason) payload.mobileTestReason = mobileTestReason;
  return { payload, errors: [] };
}

function validateIssueOutcome(
  raw: unknown,
  index: number,
): { payload: ResolveIncidentIssueOutcome | null; errors: string[] } {
  const prefix = `issueOutcomes[${index}]`;
  if (!isRecord(raw)) {
    return { payload: null, errors: [`\`${prefix}\` must be an object.`] };
  }
  const errors: string[] = [];
  const required = (key: string): string | null => {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value;
    errors.push(`\`${prefix}.${key}\` is required and must be a non-empty string.`);
    return null;
  };
  const issueId = required("issueId");
  const status = requiredEnum(errors, raw, "status", [
    "resolved",
    "silenced",
    "under_observation",
  ] as const);
  const reason = required("reason");
  const evidence = required("evidence");

  let escalateOn: (typeof ESCALATE_ON)[number] | undefined;
  let threshold: number | undefined;
  if (status === "under_observation") {
    escalateOn = requiredEnum(errors, raw, "escalateOn", ESCALATE_ON) ?? undefined;
    if (
      typeof raw.threshold !== "number" ||
      !Number.isInteger(raw.threshold) ||
      raw.threshold < 1
    ) {
      errors.push(`\`${prefix}.threshold\` must be an integer >= 1 for under_observation.`);
    } else {
      threshold = raw.threshold;
    }
  } else if (raw.escalateOn !== undefined || raw.threshold !== undefined) {
    errors.push(
      `\`${prefix}.escalateOn\` and \`${prefix}.threshold\` are forbidden unless status is "under_observation".`,
    );
  }

  if (errors.length > 0 || !issueId || !status || !reason || !evidence) {
    return { payload: null, errors };
  }
  if (status === "under_observation") {
    if (!escalateOn || threshold === undefined) return { payload: null, errors };
    return {
      payload: { issueId, status, reason, evidence, escalateOn, threshold },
      errors: [],
    };
  }
  return { payload: { issueId, status, reason, evidence }, errors: [] };
}

// Durable pre-deploy sessions retain the exact tool schemas they were created
// with. Keep their parser separate from validateOutcomeToolInput so accepting
// those immutable calls cannot weaken the strict contract advertised to new
// sessions (especially resolve_incident.issueOutcomes).
export function validateLegacyOutcomeToolInput(
  name: string,
  rawInput: unknown,
  ctx: { hasFindings: boolean },
): ValidatedLegacyOutcome {
  if (name !== "resolve_incident") {
    return { ok: false, errors: [`Unknown legacy outcome tool \`${name}\`.`] };
  }
  if (!isRecord(rawInput)) {
    return { ok: false, errors: ["Tool input must be a JSON object, not a string or array."] };
  }
  if (!ctx.hasFindings) {
    return {
      ok: false,
      errors: [
        `Call \`${REPORT_FINDINGS_TOOL_NAME}\` first to record summary/title/root cause, then call \`${name}\` again.`,
      ],
    };
  }

  const input = rawInput;
  const errors: string[] = [];
  const reason = pushRequiredString(errors, input, "reason");
  const evidence = pushRequiredString(errors, input, "evidence");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    tool: "resolve_incident",
    payload: {
      reason: reason as string,
      evidence: evidence as string,
    },
  };
}

export function validateOutcomeToolInput(
  name: string,
  rawInput: unknown,
  ctx: { hasFindings: boolean },
): ValidateOutcome {
  if ((RETIRED_OUTCOME_TOOL_NAMES as readonly string[]).includes(name)) {
    return {
      ok: false,
      errors: [
        `\`${name}\` is no longer available. Put exactly one classification for every linked Issue in \`resolve_incident.issueOutcomes\`; use \`propose_pr\` when remediation needs review, \`report_external_cause\` for an established external cause, or \`ask_human\` when a human answer is required.`,
      ],
    };
  }
  if (!(OUTCOME_TOOL_NAMES as readonly string[]).includes(name)) {
    return { ok: false, errors: [`Unknown outcome tool \`${name}\`.`] };
  }
  if (!isRecord(rawInput)) {
    return { ok: false, errors: ["Tool input must be a JSON object, not a string or array."] };
  }
  const input = rawInput;
  const errors: string[] = [];

  if (FINDINGS_REQUIRED.has(name) && !ctx.hasFindings) {
    return {
      ok: false,
      errors: [
        `Call \`${REPORT_FINDINGS_TOOL_NAME}\` first to record summary/title/root cause, then call \`${name}\` again.`,
      ],
    };
  }

  switch (name) {
    case REPORT_FINDINGS_TOOL_NAME: {
      const summary = pushRequiredString(errors, input, "summary");
      const payload: AgentRunFindings = { summary: summary ?? "" };
      const proposedTitle = optionalString(errors, input, "proposedTitle");
      if (proposedTitle !== undefined) payload.proposedTitle = proposedTitle;
      const rootCause = optionalString(errors, input, "rootCause");
      if (rootCause !== undefined) payload.rootCause = rootCause;
      const rootCauseConfidence = optionalClampedConfidence(errors, input, "rootCauseConfidence");
      if (rootCauseConfidence !== undefined) payload.rootCauseConfidence = rootCauseConfidence;
      const estimatedImpact = optionalString(errors, input, "estimatedImpact");
      if (estimatedImpact !== undefined) payload.estimatedImpact = estimatedImpact;
      const impactConfidence = optionalClampedConfidence(errors, input, "impactConfidence");
      if (impactConfidence !== undefined) payload.impactConfidence = impactConfidence;
      if (input.severity !== undefined && input.severity !== null) {
        const severity = requiredEnum(errors, input, "severity", SEVERITIES);
        if (severity) payload.severity = severity;
      }
      const handoffNotes = optionalString(errors, input, "handoffNotes");
      if (handoffNotes !== undefined) payload.handoffNotes = handoffNotes;
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, tool: REPORT_FINDINGS_TOOL_NAME, payload };
    }

    case "propose_pr": {
      // Durable sessions created against the previous singular schema can
      // outlive a deploy. Normalize that shape to a one-entry batch so they
      // can still conclude their current turn.
      let rawPullRequests: unknown[];
      if (input.pullRequests !== undefined) {
        if (!Array.isArray(input.pullRequests)) {
          return {
            ok: false,
            errors: [
              "`pullRequests` must be an actual JSON array, not a JSON-encoded string or object.",
            ],
          };
        }
        rawPullRequests = input.pullRequests;
      } else {
        rawPullRequests = [input];
      }
      if (rawPullRequests.length === 0) {
        return { ok: false, errors: ["`pullRequests` must contain at least one PR proposal."] };
      }
      const pullRequests: PullRequestProposal[] = [];
      rawPullRequests.forEach((raw, index) => {
        const validated = validatePullRequestProposal(raw, index);
        errors.push(...validated.errors);
        if (validated.payload) pullRequests.push(validated.payload);
      });
      const seenRepos = new Set<string>();
      const seenPatchPaths = new Set<string>();
      for (const proposal of pullRequests) {
        if (seenRepos.has(proposal.repoFullName)) {
          errors.push(
            `Only one PR per repository is allowed; ${proposal.repoFullName} is duplicated.`,
          );
        }
        seenRepos.add(proposal.repoFullName);
        if (seenPatchPaths.has(proposal.patchFilePath)) {
          errors.push(
            `Each PR needs a distinct patchFilePath; ${proposal.patchFilePath} is duplicated.`,
          );
        }
        seenPatchPaths.add(proposal.patchFilePath);
      }
      if (errors.length > 0) return { ok: false, errors };
      const payload: ProposePrPayload = { pullRequests };
      return { ok: true, tool: "propose_pr", payload };
    }

    case "resolve_incident": {
      const reason = pushRequiredString(errors, input, "reason");
      const evidence = pushRequiredString(errors, input, "evidence");
      if (!Array.isArray(input.issueOutcomes)) {
        errors.push("`issueOutcomes` must be an array with one outcome per linked Issue.");
      }
      const issueOutcomes: ResolveIncidentIssueOutcome[] = [];
      if (Array.isArray(input.issueOutcomes)) {
        input.issueOutcomes.forEach((raw, index) => {
          const validated = validateIssueOutcome(raw, index);
          errors.push(...validated.errors);
          if (validated.payload) issueOutcomes.push(validated.payload);
        });
      }
      const seenIssueIds = new Set<string>();
      for (const outcome of issueOutcomes) {
        if (seenIssueIds.has(outcome.issueId)) {
          errors.push(`Duplicate issue outcome for ${outcome.issueId}.`);
        }
        seenIssueIds.add(outcome.issueId);
      }
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        tool: "resolve_incident",
        payload: {
          reason: reason as string,
          evidence: evidence as string,
          issueOutcomes,
        },
      };
    }

    case "complete_investigation":
      return { ok: true, tool: "complete_investigation", payload: {} };

    case "create_linear_issue":
      return { ok: true, tool: "create_linear_issue", payload: {} };

    case "ask_human": {
      const question = pushRequiredString(errors, input, "question");
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, tool: "ask_human", payload: { question: question as string } };
    }

    case "report_external_cause": {
      const cause = pushRequiredString(errors, input, "cause");
      const source = pushRequiredString(errors, input, "source");
      const evidence = pushRequiredString(errors, input, "evidence");
      const recommendedNextStep = pushRequiredString(errors, input, "recommendedNextStep");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        tool: "report_external_cause",
        payload: {
          cause: cause as string,
          source: source as string,
          evidence: evidence as string,
          recommendedNextStep: recommendedNextStep as string,
        },
      };
    }

    default:
      return { ok: false, errors: [`Unknown outcome tool \`${name}\`.`] };
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function mergeFindings(
  prev: AgentRunFindings | null,
  next: AgentRunFindings,
): AgentRunFindings {
  if (!prev) return { ...next };
  const merged: AgentRunFindings = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function confidenceBucket(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 8) return "high";
  if (confidence >= 5) return "medium";
  return "low";
}

const DEFAULT_CONFIDENCE = 5;

function applyFindings(result: AgentRunResult, findings: AgentRunFindings): void {
  if (findings.proposedTitle != null) result.proposedTitle = findings.proposedTitle;
  if (findings.handoffNotes != null) result.handoffNotes = findings.handoffNotes;
  if (findings.severity != null) result.severity = findings.severity;
  if (findings.rootCause != null) {
    const confidence = findings.rootCauseConfidence ?? DEFAULT_CONFIDENCE;
    result.rootCause = { text: findings.rootCause, confidence };
    result.rootCauseConfidence = confidenceBucket(confidence);
  }
  if (findings.estimatedImpact != null) {
    result.estimatedImpact = {
      text: findings.estimatedImpact,
      confidence: findings.impactConfidence ?? DEFAULT_CONFIDENCE,
    };
  }
}

function mobileTestFromPr(payload: PullRequestProposal): AgentRunMobileRegressionTest | null {
  if (!payload.mobileTestStatus) return null;
  if (payload.mobileTestStatus === "created") {
    return { status: "created", testId: payload.mobileTestId as string };
  }
  return { status: payload.mobileTestStatus, reason: payload.mobileTestReason as string };
}

export function escalationTriggerFromObservation(
  payload: Pick<
    Extract<ResolveIncidentIssueOutcome, { status: "under_observation" }>,
    "escalateOn" | "threshold"
  >,
): IssueEscalationTrigger {
  return payload.escalateOn === "events_per_minute"
    ? { kind: "rate", perMinute: payload.threshold }
    : { kind: "count", count: payload.threshold };
}

// Compatibility shape for durable sessions created before classifications
// moved into resolve_incident and propose_pr became terminal.
export type ActionOutcome =
  | { name: "propose_pr"; payload: ProposePrPayload | PullRequestProposal }
  | {
      name: "silence_as_noise";
      payload: LegacySilenceAsNoisePayload;
    }
  | {
      name: "place_under_observation";
      payload: LegacyPlaceUnderObservationPayload;
    }
  | {
      name: "resolve_issue";
      payload: LegacyResolveIssuePayload;
    };

export type ExecutedAction = ActionOutcome;

function issueClassificationFromAction(action: ExecutedAction): AgentRunIssueClassification | null {
  switch (action.name) {
    case "silence_as_noise":
      return {
        issueId: action.payload.issueId,
        action: "silence",
        reason: action.payload.reason,
        evidence: action.payload.evidence,
      };
    case "place_under_observation":
      return {
        issueId: action.payload.issueId,
        action: "observe",
        reason: action.payload.reason,
        evidence: action.payload.evidence,
        trigger: escalationTriggerFromObservation(action.payload),
      };
    case "resolve_issue":
      return {
        issueId: action.payload.issueId,
        action: "resolve",
        reason: action.payload.reason,
        evidence: action.payload.evidence,
      };
    default:
      return null;
  }
}

export type AssembledOutcomeState = "complete" | "awaiting_human" | "awaiting_events";

export function assembleAgentRunResult(args: {
  findings: AgentRunFindings | null;
  // Null only for durable legacy turns that delivered PRs before propose_pr
  // became terminal.
  terminal: TerminalOutcome | null;
  // Successfully executed actions from durable legacy runs, in call order.
  actions?: ExecutedAction[];
  // Proof returned by the successful resolve_incident dispatch. Keeping it
  // in the shared assembly boundary prevents a runner backend from dropping
  // the exact event key completion uses to attribute the atomic resolution.
  incidentResolutionEventDedupeKey?: string | null;
}): AgentRunResult {
  const { findings, terminal } = args;
  const actions = args.actions ?? [];

  const state: AssembledOutcomeState =
    terminal === null
      ? "awaiting_events"
      : terminal.name === "propose_pr"
        ? "awaiting_events"
        : terminal.name === "report_external_cause"
          ? "awaiting_events"
          : terminal.name === "ask_human"
            ? "awaiting_human"
            : "complete";
  const fallbackSummary = terminal?.name === "ask_human" ? terminal.payload.question : "";
  const result: AgentRunResult = {
    state,
    summary: findings?.summary ?? fallbackSummary,
  };
  if (findings) applyFindings(result, findings);

  // Preserve action-by-action classifications from durable legacy runs.
  const classificationsByIssue = new Map<string, AgentRunIssueClassification>();
  const prs: AgentRunPr[] = [];
  const appendPr = (p: PullRequestProposal) => {
    const existingIdx = prs.findIndex(
      (pr) => pr.selectedRepoFullName === p.repoFullName && pr.branchName === p.branchName,
    );
    const mobile = mobileTestFromPr(p);
    const pr: AgentRunPr = {
      selectedRepoFullName: p.repoFullName,
      branchName: p.branchName,
      baseBranch: p.baseBranch,
      title: p.title,
      body: p.body,
      patchFilePath: p.patchFilePath,
      openStatus: "opened",
    };
    if (p.changedFiles) pr.changedFiles = p.changedFiles;
    if (mobile) pr.mobileRegressionTest = mobile;
    if (existingIdx >= 0) prs[existingIdx] = pr;
    else prs.push(pr);
    if (mobile) result.mobileRegressionTest = mobile;
  };
  for (const action of actions) {
    if (action.name === "propose_pr") {
      const payload = action.payload as ProposePrPayload | PullRequestProposal;
      const proposals = "pullRequests" in payload ? payload.pullRequests : [payload];
      proposals.forEach(appendPr);
      continue;
    }
    const classification = issueClassificationFromAction(action);
    if (classification) classificationsByIssue.set(classification.issueId, classification);
  }
  if (terminal?.name === "propose_pr") {
    terminal.payload.pullRequests.forEach(appendPr);
  }
  if (prs.length > 0) {
    result.prs = prs;
    // Old readers expect the singular field; point it at the most recent PR.
    result.pr = prs[prs.length - 1];
  }
  if (classificationsByIssue.size > 0) {
    result.issueClassifications = [...classificationsByIssue.values()];
  }

  if (terminal?.name === "resolve_incident") {
    result.incidentResolution = {
      reason: terminal.payload.reason,
      evidence: terminal.payload.evidence,
    };
    if (args.incidentResolutionEventDedupeKey) {
      result.incidentResolutionEventDedupeKey = args.incidentResolutionEventDedupeKey;
    }
    for (const outcome of terminal.payload.issueOutcomes) {
      const action: AgentRunIssueClassification["action"] =
        outcome.status === "silenced"
          ? "silence"
          : outcome.status === "under_observation"
            ? "observe"
            : "resolve";
      const classification: AgentRunIssueClassification = {
        issueId: outcome.issueId,
        action,
        reason: outcome.reason,
        evidence: outcome.evidence,
      };
      if (outcome.status === "under_observation") {
        classification.trigger = escalationTriggerFromObservation(outcome);
      }
      classificationsByIssue.set(outcome.issueId, classification);
    }
    result.issueClassifications = [...classificationsByIssue.values()];
  }
  if (terminal?.name === "complete_investigation" || terminal?.name === "create_linear_issue") {
    result.completionKind = "investigation_complete";
  }
  if (terminal?.name === "ask_human") {
    result.question = terminal.payload.question;
  }
  if (terminal?.name === "report_external_cause") {
    result.waitReason = "external_cause";
    result.externalCause = terminal.payload;
  }

  return result;
}
