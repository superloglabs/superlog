// Per-outcome tool contract for investigation agent runs.
//
// The agent ends a run by calling exactly one *terminal* outcome tool, after
// recording shared metadata via `report_findings`. Each tool has a flat JSON
// schema (top-level `type`/`properties`/`required` only — some runner APIs
// reject composition keywords like `oneOf`/`allOf` at the top level of a
// custom tool's input_schema, and a rejected schema blocks every run at
// agent-create time). Schemas are not enforced server-side by every runner,
// so `validateOutcomeToolInput` re-validates each call worker-side; its error
// strings are written for the model, which sees them as tool errors and can
// correct the call within the same session — instead of the run dying at the
// end with an unusable result.
//
// `assembleAgentRunResult` folds the merged findings plus the terminal call
// into the existing persisted `AgentRunResult` shape, so downstream consumers
// (sync/completion/PR delivery, web, graders) are unaffected by the tool
// split.

import type {
  AgentRunFailureReason,
  AgentRunMobileRegressionTest,
  AgentRunPr,
  AgentRunResult,
  IncidentNoiseReason,
  IncidentResolutionReason,
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

export const TERMINAL_OUTCOME_TOOL_NAMES = [
  "propose_pr",
  "silence_as_noise",
  "place_under_observation",
  "mark_already_resolved",
  "complete_investigation",
  "ask_human",
  "report_failure",
] as const;

export type TerminalOutcomeToolName = (typeof TERMINAL_OUTCOME_TOOL_NAMES)[number];

export const OUTCOME_TOOL_NAMES = [
  REPORT_FINDINGS_TOOL_NAME,
  ...TERMINAL_OUTCOME_TOOL_NAMES,
] as const;

const NOISE_REASONS: IncidentNoiseReason[] = [
  "cosmetic_log_only",
  "lifecycle_signal",
  "self_telemetry",
  "expected_third_party",
  "confusing_log_no_impact",
];

const RESOLUTION_REASONS: IncidentResolutionReason[] = [
  "fixed_in_current_code",
  "transient_condition_cleared",
  "upstream_recovered",
];

const SEVERITIES: IncidentSeverity[] = ["SEV-1", "SEV-2", "SEV-3"];

const DISPOSITIONS = [
  "diagnosed_needs_code_change",
  "diagnosed_external_cause",
  "informational",
] as const;

const ESCALATE_ON = ["events_per_minute", "additional_events"] as const;

const FAILURE_REASONS = ["no_findings", "patch_validation_failed"] as const;

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
    "Record what the investigation found. Call this before any completing outcome tool; call it again to revise — each defined field overwrites the previous value, omitted fields are kept. This is not a terminal tool: after reporting findings you must still end the run with exactly one outcome tool.",
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
          "Replacement incident title, 40-65 chars: affected product surface + plain-English symptom, symptom-first, never the fix. When a user-visible error string exists, use it instead of raw status codes ('Unauthorized' over '403'). No imperative verbs (Allow/Fix/Handle), no function names, exception classes, or file paths. Good: 'Routine Clerk JWT expiry is logged as ERROR'; 'Alert evaluation fails due to ClickHouse connection drops'. Bad: 'Worker read ECONNRESET from ClickHouse'; 'execute_step: missing idempotency guard causes UniqueViolationError'. Omit only if you have nothing better than the current title.",
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
          "0-10. 10 = every claim backed by a verbatim quote from a file read this session AND you observed/reproduced the failure; 7-9 = quote-backed, reproduction inferred; 4-6 = code path identified, mechanism is hypothesis; 1-3 = speculative; 0 = no evidence (prefer report_failure then).",
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
          "5-15 markdown lines for a future follow-up run on this incident (triggered by a PR comment or user reply after this session is gone): files/areas examined, hypotheses ruled out with the evidence that ruled them out, repo gotchas (build quirks, test setup), open uncertainties. Do not repeat rootCause — this is for what is NOT captured elsewhere.",
      },
    },
    required: ["summary"],
  },
};

// ---------------------------------------------------------------------------
// Terminal tools
// ---------------------------------------------------------------------------

export type ProposePrPayload = {
  repoFullName: string;
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  patchFilePath: string;
  validationPassed: boolean;
  validationSummary: string;
  validationCommands?: string[];
  changedFiles?: string[];
  mobileTestStatus?: (typeof MOBILE_TEST_STATUSES)[number];
  mobileTestId?: string;
  mobileTestReason?: string;
};

const PROPOSE_PR_DEFINITION: OutcomeToolDefinition = {
  name: "propose_pr",
  description:
    "Terminal: you produced a validated patch. Hand the patch off by writing a unified diff to /mnt/session/outputs/superlog.patch (git diff format, applying cleanly to baseBranch) — never inline the diff in this call. Validate the patch yourself before calling; the worker only applies it and opens the PR. Validation ladder — stop at the strongest rung you can execute: (1) the repo's own build/typecheck/tests; (2) targeted tests for the changed module, including regression tests you add with the patch; (3) direct execution of the changed logic or a scripted repro that fails before and passes after. Structural checks (grepping the new code for expected strings) are NOT validation — never set validationPassed on their basis; validation means executing something and reporting observed output. If your patch restructures existing logic (batching queries, hoisting work out of a loop, caching, dedup, reordering), it must be behaviorally identical on every input, not just fix the headline problem: enumerate what the old code could observe that the new cannot (rows written by earlier loop iterations, first-wins vs last-wins on duplicate keys, ordering, null keys, error paths), check each with a concrete example, and add a regression test encoding the ORIGINAL behavior that passes before and after. Set validationPassed=false only when the validation you executed failed or nothing on the ladder could run at all.",
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
        description: "Must start with 'superlog/' followed by a short kebab-case slug, e.g. superlog/fix-cart-batching.",
      },
      baseBranch: { type: "string", description: "The branch the PR should target (the repo's active development branch)." },
      patchFilePath: {
        type: "string",
        description: "Where you wrote the unified diff, normally /mnt/session/outputs/superlog.patch.",
      },
      validationPassed: {
        type: "boolean",
        description:
          "True only when the strongest validation rung you could actually execute passed. An honest false is acceptable; fabricated validation is not.",
      },
      validationSummary: {
        type: "string",
        description:
          "Exactly what ran, what could not run, and why (surfaced in the PR body). Include before/after repro outcomes when you have them.",
      },
      validationCommands: {
        type: "array",
        items: { type: "string" },
        description: "The commands you executed as validation. Never list greps/structural checks here.",
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
    required: [
      "repoFullName",
      "title",
      "body",
      "branchName",
      "baseBranch",
      "patchFilePath",
      "validationPassed",
      "validationSummary",
    ],
  },
};

export type SilenceAsNoisePayload = { reason: IncidentNoiseReason; evidence: string };

const NOISE_REASON_GUIDE =
  "Reasons: cosmetic_log_only = the primary operation completed successfully and the ERROR is a downstream cosmetic side-effect (evidence must show the operation returned before the error fired). lifecycle_signal = fires only during process lifecycle (SIGTERM, teardown) and in-flight work completed or is retried (evidence must reference the lifecycle hook). self_telemetry = the customer's own telemetry/observability export failing (OTLP timeout, metrics 429); the application is unaffected — evidence may point at third-party exporter code. expected_third_party = the third-party API error is part of its documented contract for this call site (Slack already_reacted, idempotency conflicts); not for real provider outages the customer must act on. confusing_log_no_impact = the log is technically correct but the surrounding code recovers (retry succeeds, fallback fires) — evidence must show the recovery path runs.";

const SILENCE_AS_NOISE_DEFINITION: OutcomeToolDefinition = {
  name: "silence_as_noise",
  description: `Terminal: the error is proven noise — the operation it describes either succeeded or has no user/business impact. The incident resolves and its issues are silenced: recurrences stop paging permanently, so the bar is high. You must quote the success path, the no-op contract, or the third-party contract clause; if you cannot prove it, use place_under_observation instead. Do NOT propose code changes to downgrade/log-catch false-positive errors — silencing is the correct action, not a PR. ${NOISE_REASON_GUIDE}`,
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", enum: NOISE_REASONS, description: "The noise category that fits the evidence." },
      evidence: {
        type: "string",
        description: `1-3 sentences quoting the success/recovery/contract clause that justifies silencing. ${EVIDENCE_FORMAT}`,
      },
    },
    required: ["reason", "evidence"],
  },
};

export type PlaceUnderObservationPayload = {
  reason: IncidentNoiseReason;
  evidence: string;
  escalateOn: (typeof ESCALATE_ON)[number];
  threshold: number;
};

const PLACE_UNDER_OBSERVATION_DEFINITION: OutcomeToolDefinition = {
  name: "place_under_observation",
  description:
    `Terminal: the error is plausibly noise (a one-off, a non-critical event) but you cannot fully prove no-impact, or it could matter if it grows. The incident resolves and its issues go under observation: recurrences stay quiet until the escalation trigger trips, then a new investigation starts with your findings as context. Prefer this over silence_as_noise whenever the evidence bar for permanent silencing is not met. ${NOISE_REASON_GUIDE}`,
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", enum: NOISE_REASONS, description: "Your best-guess noise category." },
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
    required: ["reason", "evidence", "escalateOn", "threshold"],
  },
};

export type MarkAlreadyResolvedPayload = { reason: IncidentResolutionReason; evidence: string };

const MARK_ALREADY_RESOLVED_DEFINITION: OutcomeToolDefinition = {
  name: "mark_already_resolved",
  description:
    "Terminal: the incident was real but is already resolved and needs no remediation now. The incident and its issues are marked resolved (a recurrence starts a fresh investigation). Not for noise/no-impact cases (use silence_as_noise) and not just because errors are quiet in a tiny sample. Reasons: fixed_in_current_code = the current code already contains the fix/guard — quote the fixing code or the merged change. transient_condition_cleared = telemetry shows the failing condition recovered and stayed healthy after the incident window — include the before/after signal and window. upstream_recovered = the failing dependency/provider recovered — name the dependency and the observed recovery signal.",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", enum: RESOLUTION_REASONS, description: "Why the incident is already resolved." },
      evidence: {
        type: "string",
        description: `1-3 sentences citing the code/telemetry/status evidence proving resolution, with concrete windows/counts when telemetry is the proof. ${EVIDENCE_FORMAT}`,
      },
    },
    required: ["reason", "evidence"],
  },
};

export type CompleteInvestigationPayload = {
  disposition: (typeof DISPOSITIONS)[number];
  recommendedAction?: string;
};

const COMPLETE_INVESTIGATION_DEFINITION: OutcomeToolDefinition = {
  name: "complete_investigation",
  description:
    "Terminal: you diagnosed the problem but the remediation is not yours to make — no patch, no noise verdict, no resolution claim. The incident stays open with your findings recorded for the humans who must act. Use this when the failing code lives outside the mounted repos (third-party library defect, external API contract), when the customer must act (raise a provider quota, change a region, update env/config), or when a human decision is needed between remediation paths. NEVER use report_failure for a diagnosis you actually made — that throws the diagnosis away.",
  input_schema: {
    type: "object",
    properties: {
      disposition: {
        type: "string",
        enum: DISPOSITIONS,
        description:
          "diagnosed_needs_code_change = a code fix is warranted but was not produced this run (policy or missing access). diagnosed_external_cause = the cause is outside the mounted repos and the customer/provider must act. informational = findings recorded, no action required.",
      },
      recommendedAction: {
        type: "string",
        description: "One sentence: the concrete next step a human should take.",
      },
    },
    required: ["disposition"],
  },
};

export type AskHumanPayload = { question: string };

const ASK_HUMAN_DEFINITION: OutcomeToolDefinition = {
  name: "ask_human",
  description:
    "Terminal: you need specific missing context to continue; the run pauses until a human replies, then resumes with your session intact. Ask for the specific thing you need (expected behavior, a suspected owner, a recent deploy, a repro hint) and include the best leads you checked. Wrong-repo escape hatch: if telemetry names a concrete code artifact (file path, function, exception class, endpoint) that is genuinely absent from every mounted repo at HEAD and across remote branches, use this tool — quote the missing artifact, name the repos you searched, and ask which repo owns the code. Do not use report_failure for that case: more repos exist than were mounted into this session.",
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

export type ReportFailurePayload = { reason: (typeof FAILURE_REASONS)[number]; detail: string };

const REPORT_FAILURE_DEFINITION: OutcomeToolDefinition = {
  name: "report_failure",
  description:
    "Terminal: the run itself failed. no_findings is RESERVED for 'I searched the application and genuinely cannot locate the failing code path' — NOT for 'I found the path but it lives in a third-party library or external system' (that is complete_investigation or silence_as_noise) and NOT for 'the artifact is missing from every mounted repo' (that is ask_human). Do not infer code structure from memory of similar codebases — an honest no_findings beats guessing. patch_validation_failed = you produced a patch but your own validation of it failed.",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", enum: FAILURE_REASONS, description: "Why the run failed." },
      detail: {
        type: "string",
        description:
          "For no_findings, start with 'Insufficient evidence:' and list the specific files/regions you searched and could not locate or read. For patch_validation_failed, what validation ran and how it failed.",
      },
    },
    required: ["reason", "detail"],
  },
};

export const OUTCOME_TOOL_DEFINITIONS: OutcomeToolDefinition[] = [
  REPORT_FINDINGS_DEFINITION,
  PROPOSE_PR_DEFINITION,
  SILENCE_AS_NOISE_DEFINITION,
  PLACE_UNDER_OBSERVATION_DEFINITION,
  MARK_ALREADY_RESOLVED_DEFINITION,
  COMPLETE_INVESTIGATION_DEFINITION,
  ASK_HUMAN_DEFINITION,
  REPORT_FAILURE_DEFINITION,
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type TerminalOutcome =
  | { name: "propose_pr"; payload: ProposePrPayload }
  | { name: "silence_as_noise"; payload: SilenceAsNoisePayload }
  | { name: "place_under_observation"; payload: PlaceUnderObservationPayload }
  | { name: "mark_already_resolved"; payload: MarkAlreadyResolvedPayload }
  | { name: "complete_investigation"; payload: CompleteInvestigationPayload }
  | { name: "ask_human"; payload: AskHumanPayload }
  | { name: "report_failure"; payload: ReportFailurePayload };

export type ValidateOutcome =
  | { ok: true; tool: "report_findings"; payload: AgentRunFindings }
  | { ok: true; tool: TerminalOutcomeToolName; payload: TerminalOutcome["payload"] }
  | { ok: false; errors: string[] };

// Terminal tools that conclude the investigation with findings the humans
// will read — these refuse to run until report_findings has been called.
const FINDINGS_REQUIRED = new Set<string>([
  "propose_pr",
  "silence_as_noise",
  "place_under_observation",
  "mark_already_resolved",
  "complete_investigation",
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
      const validationSummary = pushRequiredString(errors, input, "validationSummary");
      if (typeof input.validationPassed !== "boolean") {
        errors.push("`validationPassed` is required and must be a boolean.");
      }
      if (branchName && !branchName.startsWith("superlog/")) {
        errors.push(
          `\`branchName\` must start with \`superlog/\`; you sent ${JSON.stringify(branchName)}.`,
        );
      }
      const validationCommands = optionalStringArray(errors, input, "validationCommands");
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
        validationPassed: input.validationPassed as boolean,
        validationSummary: validationSummary as string,
      };
      if (validationCommands) payload.validationCommands = validationCommands;
      if (changedFiles) payload.changedFiles = changedFiles;
      if (mobileTestStatus) payload.mobileTestStatus = mobileTestStatus;
      if (mobileTestId) payload.mobileTestId = mobileTestId;
      if (mobileTestReason) payload.mobileTestReason = mobileTestReason;
      return { ok: true, tool: "propose_pr", payload };
    }

    case "silence_as_noise":
    case "place_under_observation": {
      const reason = requiredEnum(errors, input, "reason", NOISE_REASONS);
      const evidence = pushRequiredString(errors, input, "evidence");
      if (name === "silence_as_noise") {
        if (errors.length > 0) return { ok: false, errors };
        return {
          ok: true,
          tool: name,
          payload: { reason: reason as IncidentNoiseReason, evidence: evidence as string },
        };
      }
      const escalateOn = requiredEnum(errors, input, "escalateOn", ESCALATE_ON);
      const threshold = input.threshold;
      if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1) {
        errors.push(
          `\`threshold\` must be an integer >= 1; you sent ${JSON.stringify(threshold)}.`,
        );
      }
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        tool: "place_under_observation",
        payload: {
          reason: reason as IncidentNoiseReason,
          evidence: evidence as string,
          escalateOn: escalateOn as PlaceUnderObservationPayload["escalateOn"],
          threshold: threshold as number,
        },
      };
    }

    case "mark_already_resolved": {
      const reason = requiredEnum(errors, input, "reason", RESOLUTION_REASONS);
      const evidence = pushRequiredString(errors, input, "evidence");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        tool: "mark_already_resolved",
        payload: { reason: reason as IncidentResolutionReason, evidence: evidence as string },
      };
    }

    case "complete_investigation": {
      const disposition = requiredEnum(errors, input, "disposition", DISPOSITIONS);
      const recommendedAction = optionalString(errors, input, "recommendedAction");
      if (errors.length > 0) return { ok: false, errors };
      const payload: CompleteInvestigationPayload = {
        disposition: disposition as CompleteInvestigationPayload["disposition"],
      };
      if (recommendedAction) payload.recommendedAction = recommendedAction;
      return { ok: true, tool: "complete_investigation", payload };
    }

    case "ask_human": {
      const question = pushRequiredString(errors, input, "question");
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, tool: "ask_human", payload: { question: question as string } };
    }

    case "report_failure": {
      const reason = requiredEnum(errors, input, "reason", FAILURE_REASONS);
      const detail = pushRequiredString(errors, input, "detail");
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        tool: "report_failure",
        payload: {
          reason: reason as ReportFailurePayload["reason"],
          detail: detail as string,
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

function mobileTestFromPr(payload: ProposePrPayload): AgentRunMobileRegressionTest | null {
  if (!payload.mobileTestStatus) return null;
  if (payload.mobileTestStatus === "created") {
    return { status: "created", testId: payload.mobileTestId as string };
  }
  return { status: payload.mobileTestStatus, reason: payload.mobileTestReason as string };
}

function triggerFromObservation(payload: PlaceUnderObservationPayload): IssueEscalationTrigger {
  return payload.escalateOn === "events_per_minute"
    ? { kind: "rate", perMinute: payload.threshold }
    : { kind: "count", count: payload.threshold };
}

export function assembleAgentRunResult(args: {
  findings: AgentRunFindings | null;
  terminal: TerminalOutcome;
}): AgentRunResult {
  const { findings, terminal } = args;

  const fallbackSummary =
    terminal.name === "ask_human"
      ? terminal.payload.question
      : terminal.name === "report_failure"
        ? terminal.payload.detail
        : "";
  const result: AgentRunResult = {
    state:
      terminal.name === "ask_human"
        ? "awaiting_human"
        : terminal.name === "report_failure"
          ? "failed"
          : "complete",
    summary: findings?.summary ?? fallbackSummary,
  };
  if (findings) applyFindings(result, findings);

  switch (terminal.name) {
    case "propose_pr": {
      const p = terminal.payload;
      const pr: AgentRunPr = {
        selectedRepoFullName: p.repoFullName,
        branchName: p.branchName,
        baseBranch: p.baseBranch,
        title: p.title,
        body: p.body,
        patchFilePath: p.patchFilePath,
        validationPassed: p.validationPassed,
        validationSummary: p.validationSummary,
        openStatus: "pending",
      };
      if (p.validationCommands) pr.validationCommands = p.validationCommands;
      if (p.changedFiles) pr.changedFiles = p.changedFiles;
      result.pr = pr;
      const mobile = mobileTestFromPr(p);
      if (mobile) result.mobileRegressionTest = mobile;
      break;
    }
    case "silence_as_noise":
      result.noiseClassification = {
        reason: terminal.payload.reason,
        evidence: terminal.payload.evidence,
        action: { kind: "silence" },
      };
      break;
    case "place_under_observation":
      result.noiseClassification = {
        reason: terminal.payload.reason,
        evidence: terminal.payload.evidence,
        action: { kind: "observe", trigger: triggerFromObservation(terminal.payload) },
      };
      break;
    case "mark_already_resolved":
      result.resolutionClassification = {
        reason: terminal.payload.reason,
        evidence: terminal.payload.evidence,
      };
      break;
    case "complete_investigation":
      result.disposition = terminal.payload.disposition;
      if (terminal.payload.recommendedAction) {
        result.recommendedAction = terminal.payload.recommendedAction;
      }
      break;
    case "ask_human":
      result.question = terminal.payload.question;
      break;
    case "report_failure":
      result.failureReason =
        terminal.payload.reason === "no_findings"
          ? ("agent_no_findings" as AgentRunFailureReason)
          : ("patch_validation_failed" as AgentRunFailureReason);
      break;
  }

  return result;
}
