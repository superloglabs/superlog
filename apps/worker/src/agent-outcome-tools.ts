// Per-outcome tool contract for investigation agent runs.
//
// The contract has three tiers:
//   - `report_findings` (non-terminal): shared metadata, callable repeatedly.
//   - Action tools (non-terminal, dispatched server-side mid-run): the worker
//     executes each call while the session is live and acks the result back,
//     so the agent can iterate — open a PR, read the URL (or the apply
//     failure and fix its own patch), classify each linked issue, then keep
//     going. `propose_pr`, `silence_as_noise`, `place_under_observation`,
//     `resolve_issue`.
//   - Terminal tools: `resolve_incident` ends the investigation once every
//     linked issue is classified; `ask_human` pauses it on a human. A turn may
//     also legitimately end with NO terminal call when the run is waiting on
//     external events (open PRs) — the worker parks it and resumes the session
//     when a PR comment/merge/close arrives.
//
// Each tool has a flat JSON schema (top-level `type`/`properties`/`required`
// only — some runner APIs reject composition keywords like `oneOf`/`allOf` at
// the top level of a custom tool's input_schema, and a rejected schema blocks
// every run at agent-create time). Schemas are not enforced server-side by
// every runner, so `validateOutcomeToolInput` re-validates each call
// worker-side; its error strings are written for the model, which sees them
// as tool errors and can correct the call within the same session.
//
// `assembleAgentRunResult` folds the merged findings, the mid-run actions,
// and the terminal call into the persisted `AgentRunResult` shape.

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

// Non-terminal action tools: executed server-side while the run is live, the
// result is acked back into the session and the agent continues its turn.
export const ACTION_OUTCOME_TOOL_NAMES = [
  "propose_pr",
  "silence_as_noise",
  "place_under_observation",
  "resolve_issue",
] as const;

export type ActionOutcomeToolName = (typeof ACTION_OUTCOME_TOOL_NAMES)[number];

export const TERMINAL_OUTCOME_TOOL_NAMES = ["resolve_incident", "ask_human"] as const;

export type TerminalOutcomeToolName = (typeof TERMINAL_OUTCOME_TOOL_NAMES)[number];

// Tools retired from the contract. Sessions created against an old toolset
// can outlive a deploy (a parked run resumes days later), so a call to one of
// these must be error-acked with redirect guidance — not routed to the
// unknown-tool path, which hard-fails the run.
export const RETIRED_OUTCOME_TOOL_NAMES = [
  "complete_investigation",
  "report_failure",
  "mark_already_resolved",
] as const;

export const OUTCOME_TOOL_NAMES = [
  REPORT_FINDINGS_TOOL_NAME,
  ...ACTION_OUTCOME_TOOL_NAMES,
  ...TERMINAL_OUTCOME_TOOL_NAMES,
] as const;

export function isActionOutcomeToolName(name: string): name is ActionOutcomeToolName {
  return (ACTION_OUTCOME_TOOL_NAMES as readonly string[]).includes(name);
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
// Action tools (non-terminal, server-dispatched)
// ---------------------------------------------------------------------------

export type ProposePrPayload = {
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

const PROPOSE_PR_DEFINITION: OutcomeToolDefinition = {
  name: "propose_pr",
  description:
    "Open a pull request with a patch you authored, for a defect with REAL user or business impact. NOT terminal: the platform applies your patch and opens the PR while you are still running, and returns the PR URL — or the apply failure, which you can fix and retry. Call it again with a NEW branchName to open an additional, independent PR; calling it again with the SAME branchName pushes the new patch as a follow-up commit on that PR (do this when addressing review feedback). NOT for noise: if the error you diagnosed is a false positive or the operation returns its intended response, call silence_as_noise instead — a patch that only quiets a signal (log levels, span statuses, recordException, catching expected errors) is the wrong outcome no matter how clean the fix is, and 'alert fatigue from the noisy signal' does not count as impact (silencing is what fixes alert fatigue). Hand the patch off by writing a unified diff to a file under /mnt/session/outputs/ (git diff format, applying cleanly to baseBranch; use a distinct file per PR) — never inline the diff in this call. Validate the patch yourself before calling — the worker only applies it and opens the PR. After your PRs are up, either resolve the incident (resolve_incident, once every issue is classified) or end your turn to wait for review — you will be resumed when the PR gets a comment, merge, or close.",
  input_schema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: "owner/repo of the mounted repository the patch targets." },
      title: {
        type: "string",
        description:
          "Exact PR title for human review: '[superlog] <imperative fix summary>' describing the fix outcome, not the incident title.",
      },
      body: {
        type: "string",
        description:
          "Review-ready markdown. Default shape: '# Summary', one paragraph for the user-visible symptom, one for the root-cause mechanism in plain English, one for the remediation direction (briefly mention credible alternative approaches if any), then a final '[Incident on Superlog](<incident url>)' link. Follow the org PR template instead when one is provided.",
      },
      branchName: {
        type: "string",
        pattern: "^superlog/",
        description:
          "Must start with 'superlog/' followed by a short kebab-case slug, e.g. superlog/fix-cart-batching. Reuse a branch name to push to that PR; use a new one to open a separate PR.",
      },
      baseBranch: { type: "string", description: "The branch the PR should target (the repo's active development branch)." },
      patchFilePath: {
        type: "string",
        description:
          "Where you wrote the unified diff, e.g. /mnt/session/outputs/superlog-fix-cart-batching.patch. Use a distinct file per PR so a later PR's patch never overwrites an earlier one.",
      },
      changedFiles: { type: "array", items: { type: "string" }, description: "Repo-relative paths the patch touches." },
      mobileTestStatus: {
        type: "string",
        enum: MOBILE_TEST_STATUSES,
        description:
          "Only for orgs with a mobile-regression integration: whether you created a regression test for this fix ('created' requires mobileTestId; 'skipped'/'not_applicable' require mobileTestReason).",
      },
      mobileTestId: { type: "string", description: "The created mobile regression test id." },
      mobileTestReason: { type: "string", description: "Why the mobile regression test was skipped / not applicable." },
    },
    required: ["repoFullName", "title", "body", "branchName", "baseBranch", "patchFilePath"],
  },
};

export type SilenceAsNoisePayload = { issueId: string; reason: string; evidence: string };

const SILENCE_AS_NOISE_DEFINITION: OutcomeToolDefinition = {
  name: "silence_as_noise",
  description:
    "Silence one linked issue as proven noise — the operation it describes either succeeded or has no user/business impact. NOT terminal: the issue is silenced immediately and you continue; classify each linked issue individually (the issue ids are in the incident issue bundle), then finish with resolve_incident. Recurrences of a silenced issue stop paging permanently, so the bar is high: you must quote the success path, the no-op contract, or the third-party contract clause. If you cannot prove it, use place_under_observation instead. Do NOT propose code changes to make the false positive quieter — downgrading log levels, catching/suppressing expected errors, or changing span statuses / recordException calls for expected conditions. Silencing is the correct action, not a PR, even when the noisy signal comes from the application's own instrumentation. Only error issues can be silenced; alert-episode issues can only be resolved (resolve_issue).",
  input_schema: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "The id of the linked issue to silence (from the incident issue bundle)." },
      reason: {
        type: "string",
        description:
          "Free text: why this is noise, in one plain-English sentence an operator can read in a list (e.g. 'Expected 404s from bot traffic probing /wp-admin').",
      },
      evidence: {
        type: "string",
        description: `1-3 sentences quoting the success/recovery/contract clause that justifies silencing. ${EVIDENCE_FORMAT}`,
      },
    },
    required: ["issueId", "reason", "evidence"],
  },
};

export type PlaceUnderObservationPayload = {
  issueId: string;
  reason: string;
  evidence: string;
  escalateOn: (typeof ESCALATE_ON)[number];
  threshold: number;
};

const PLACE_UNDER_OBSERVATION_DEFINITION: OutcomeToolDefinition = {
  name: "place_under_observation",
  description:
    "Place one linked issue under observation — plausibly noise (a one-off, a non-critical event) but you cannot fully prove no-impact, or it could matter if it grows. NOT terminal: the issue goes quiet immediately and you continue; finish with resolve_incident once every issue is classified. Recurrences stay quiet until the escalation trigger trips, then a new investigation starts with your findings as context. Prefer this over silence_as_noise whenever the evidence bar for permanent silencing is not met. Only error issues can be observed; alert-episode issues can only be resolved (resolve_issue).",
  input_schema: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "The id of the linked issue to observe (from the incident issue bundle)." },
      reason: {
        type: "string",
        description:
          "Free text: your best guess at why this is noise, in one plain-English sentence an operator can read in a list.",
      },
      evidence: {
        type: "string",
        description:
          "Why suppression is likely safe AND what growth pattern would change your mind. Quote what you verified.",
      },
      escalateOn: {
        type: "string",
        enum: ESCALATE_ON,
        description:
          "events_per_minute = escalate when the issue's trailing 5-minute average rate reaches the threshold. additional_events = escalate when the issue accumulates this many new events after observation begins.",
      },
      threshold: {
        type: "integer",
        minimum: 1,
        description: "The rate (per minute) or event count that should trigger re-investigation.",
      },
    },
    required: ["issueId", "reason", "evidence", "escalateOn", "threshold"],
  },
};

export type ResolveIssuePayload = { issueId: string; reason: string; evidence: string };

const RESOLVE_ISSUE_DEFINITION: OutcomeToolDefinition = {
  name: "resolve_issue",
  description:
    "Resolve one linked issue: its impact has ceased and no further action on it is possible or needed — the current code already contains the fix, the transient condition cleared, the upstream dependency recovered, or your own remediation (a merged PR, an executed approval) addressed it. NOT terminal: the issue resolves immediately and you continue; finish with resolve_incident once every issue is classified. A resolved issue that recurs starts a fresh investigation with this one's findings as context — so this is not for noise (use silence_as_noise / place_under_observation) and not just because errors are quiet in a tiny sample.",
  input_schema: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "The id of the linked issue to resolve (from the incident issue bundle)." },
      reason: {
        type: "string",
        description:
          "Free text: why this issue is resolved, in one plain-English sentence an operator can read in a list (e.g. 'Fixed by the retry-guard PR merged during this investigation').",
      },
      evidence: {
        type: "string",
        description: `1-3 sentences citing the code/telemetry/status evidence proving resolution, with before/after signal and concrete windows/counts when telemetry is the proof. ${EVIDENCE_FORMAT}`,
      },
    },
    required: ["issueId", "reason", "evidence"],
  },
};

// ---------------------------------------------------------------------------
// Terminal tools
// ---------------------------------------------------------------------------

export type ResolveIncidentPayload = { reason: string; evidence: string };

const RESOLVE_INCIDENT_DEFINITION: OutcomeToolDefinition = {
  name: "resolve_incident",
  description:
    "Terminal: resolve the incident. Call this when the impact on the system has ceased (or there never was any), or your actions (merged PRs, executed approvals) have resolved the root cause. Every issue linked to the incident must already be classified — silenced, under observation, or resolved — via the per-issue tools; this call is rejected with the list of unclassified issues otherwise. Do NOT resolve while you are still waiting on an open PR you expect to be merged — end your turn instead and you will be resumed when the PR gets a comment, merge, or close.",
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
    },
    required: ["reason", "evidence"],
  },
};

export type AskHumanPayload = { question: string };

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
  SILENCE_AS_NOISE_DEFINITION,
  PLACE_UNDER_OBSERVATION_DEFINITION,
  RESOLVE_ISSUE_DEFINITION,
  RESOLVE_INCIDENT_DEFINITION,
  ASK_HUMAN_DEFINITION,
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ActionOutcome =
  | { name: "propose_pr"; payload: ProposePrPayload }
  | { name: "silence_as_noise"; payload: SilenceAsNoisePayload }
  | { name: "place_under_observation"; payload: PlaceUnderObservationPayload }
  | { name: "resolve_issue"; payload: ResolveIssuePayload };

export type TerminalOutcome =
  | { name: "resolve_incident"; payload: ResolveIncidentPayload }
  | { name: "ask_human"; payload: AskHumanPayload };

export type ValidateOutcome =
  | { ok: true; tool: "report_findings"; payload: AgentRunFindings }
  | { ok: true; tool: ActionOutcomeToolName; payload: ActionOutcome["payload"] }
  | { ok: true; tool: TerminalOutcomeToolName; payload: TerminalOutcome["payload"] }
  | { ok: false; errors: string[] };

// Tools that conclude with findings humans will read — these refuse to run
// until report_findings has been called.
const FINDINGS_REQUIRED = new Set<string>([
  "propose_pr",
  "silence_as_noise",
  "place_under_observation",
  "resolve_issue",
  "resolve_incident",
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

export function validateOutcomeToolInput(
  name: string,
  rawInput: unknown,
  ctx: { hasFindings: boolean },
): ValidateOutcome {
  if ((RETIRED_OUTCOME_TOOL_NAMES as readonly string[]).includes(name)) {
    return {
      ok: false,
      errors: [
        `\`${name}\` is no longer available. Classify each linked issue with \`silence_as_noise\`, \`place_under_observation\`, or \`resolve_issue\`; open PRs with \`propose_pr\`; then finish the run with \`resolve_incident\` (or \`ask_human\` when a human must act or answer first).`,
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
      const repoFullName = pushRequiredString(errors, input, "repoFullName");
      const title = pushRequiredString(errors, input, "title");
      const body = pushRequiredString(errors, input, "body");
      const branchName = pushRequiredString(errors, input, "branchName");
      const baseBranch = pushRequiredString(errors, input, "baseBranch");
      const patchFilePath = pushRequiredString(errors, input, "patchFilePath");
      if (branchName && !branchName.startsWith("superlog/")) {
        errors.push(
          `\`branchName\` must start with \`superlog/\`; you sent ${JSON.stringify(branchName)}.`,
        );
      }
      // Legacy sessions still send validationPassed; an honest false meant
      // "do not open this PR", so keep honoring it rather than shipping a
      // patch its author reported as failing.
      if (input.validationPassed === false) {
        errors.push(
          "You reported `validationPassed: false`. Do not propose a PR whose validation failed — fix the patch and call `propose_pr` again once it validates.",
        );
      }
      const changedFiles = optionalStringArray(errors, input, "changedFiles");
      let mobileTestStatus: ProposePrPayload["mobileTestStatus"];
      if (input.mobileTestStatus !== undefined && input.mobileTestStatus !== null) {
        mobileTestStatus =
          requiredEnum(errors, input, "mobileTestStatus", MOBILE_TEST_STATUSES) ?? undefined;
      }
      const mobileTestId = optionalString(errors, input, "mobileTestId");
      const mobileTestReason = optionalString(errors, input, "mobileTestReason");
      if (mobileTestStatus === "created" && !mobileTestId) {
        errors.push("`mobileTestId` is required when `mobileTestStatus` is \"created\".");
      }
      if (
        (mobileTestStatus === "skipped" || mobileTestStatus === "not_applicable") &&
        !mobileTestReason
      ) {
        errors.push(
          "`mobileTestReason` is required when `mobileTestStatus` is \"skipped\" or \"not_applicable\".",
        );
      }
      if (errors.length > 0) return { ok: false, errors };
      const payload: ProposePrPayload = {
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
      return { ok: true, tool: "propose_pr", payload };
    }

    case "silence_as_noise":
    case "resolve_issue": {
      const issueId = pushRequiredString(errors, input, "issueId");
      const reason = pushRequiredString(errors, input, "reason");
      const evidence = pushRequiredString(errors, input, "evidence");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        tool: name,
        payload: {
          issueId: issueId as string,
          reason: reason as string,
          evidence: evidence as string,
        },
      };
    }

    case "place_under_observation": {
      const issueId = pushRequiredString(errors, input, "issueId");
      const reason = pushRequiredString(errors, input, "reason");
      const evidence = pushRequiredString(errors, input, "evidence");
      const escalateOn = requiredEnum(errors, input, "escalateOn", ESCALATE_ON);
      const threshold = input.threshold;
      if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1) {
        errors.push(`\`threshold\` must be an integer >= 1; you sent ${JSON.stringify(threshold)}.`);
      }
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        tool: "place_under_observation",
        payload: {
          issueId: issueId as string,
          reason: reason as string,
          evidence: evidence as string,
          escalateOn: escalateOn as PlaceUnderObservationPayload["escalateOn"],
          threshold: threshold as number,
        },
      };
    }

    case "resolve_incident": {
      const reason = pushRequiredString(errors, input, "reason");
      const evidence = pushRequiredString(errors, input, "evidence");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        tool: "resolve_incident",
        payload: { reason: reason as string, evidence: evidence as string },
      };
    }

    case "ask_human": {
      const question = pushRequiredString(errors, input, "question");
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, tool: "ask_human", payload: { question: question as string } };
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

function mobileTestFromPr(payload: ProposePrPayload): AgentRunMobileRegressionTest | null {
  if (!payload.mobileTestStatus) return null;
  if (payload.mobileTestStatus === "created") {
    return { status: "created", testId: payload.mobileTestId as string };
  }
  return { status: payload.mobileTestStatus, reason: payload.mobileTestReason as string };
}

export function escalationTriggerFromObservation(
  payload: Pick<PlaceUnderObservationPayload, "escalateOn" | "threshold">,
): IssueEscalationTrigger {
  return payload.escalateOn === "events_per_minute"
    ? { kind: "rate", perMinute: payload.threshold }
    : { kind: "count", count: payload.threshold };
}

// A successfully executed mid-run action (the dispatch loop applied its
// effect and acked ok), replayed from the session event stream so the final
// result can record what happened during the run.
export type ExecutedAction = ActionOutcome;

function issueClassificationFromAction(
  action: ExecutedAction,
): AgentRunIssueClassification | null {
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
  // Null when the turn ended without a terminal call (the run parks on
  // awaiting_events while its PRs are out for review).
  terminal: TerminalOutcome | null;
  // Successfully executed mid-run actions, in call order.
  actions?: ExecutedAction[];
}): AgentRunResult {
  const { findings, terminal } = args;
  const actions = args.actions ?? [];

  const state: AssembledOutcomeState =
    terminal === null
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

  // Latest action per issue wins (the agent corrected itself mid-run).
  const classificationsByIssue = new Map<string, AgentRunIssueClassification>();
  const prs: AgentRunPr[] = [];
  for (const action of actions) {
    if (action.name === "propose_pr") {
      const p = action.payload;
      const existingIdx = prs.findIndex(
        (pr) => pr.selectedRepoFullName === p.repoFullName && pr.branchName === p.branchName,
      );
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
      if (existingIdx >= 0) prs[existingIdx] = pr;
      else prs.push(pr);
      const mobile = mobileTestFromPr(p);
      if (mobile) result.mobileRegressionTest = mobile;
      continue;
    }
    const classification = issueClassificationFromAction(action);
    if (classification) classificationsByIssue.set(classification.issueId, classification);
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
  }
  if (terminal?.name === "ask_human") {
    result.question = terminal.payload.question;
  }

  return result;
}
