// Validates and normalises the raw `input` of an agent's
// submit_agent_run_result tool call into a ManagedSessionResult.
//
// Why this exists: the tool's `input_schema` is declared on the
// Anthropic SDK call but isn't enforced server-side for custom tools, so a
// misbehaving model can hand us anything — flat strings where we expect
// `{ text, confidence }` objects, missing required fields, garbage enums.
// Previously the worker did `result = input as ManagedSessionResult` and
// persisted whatever the agent produced; the issue-detail UI then crashed
// trying to render `result.estimatedImpact.text` when `estimatedImpact` was
// secretly a string. See incident fae38dd9-7887-4f11-b924-2b30c5677104.
//
// Strategy:
//   - The two required fields (`state`, `summary`) must validate or the
//     whole result is rejected — without them the result is meaningless.
//   - Every optional structured field is dropped (set to null) when its
//     shape doesn't match, and the dropped field name is reported so the
//     caller can log it. This preserves whatever salvageable signal the
//     agent did get right.

import type {
  AgentRunLinearTicket,
  AgentRunMobileRegressionTest,
  AgentRunPr,
  AgentRunResult,
  IncidentNoiseClassification,
  IncidentResolutionClassification,
} from "@superlog/db";

type AgentFailureReason = "agent_no_findings" | "patch_validation_failed";
type ManagedSessionResult = Omit<AgentRunResult, "failureReason"> & {
  failureReason?: AgentFailureReason | null;
};

export type NormalizeResult =
  | { ok: true; result: ManagedSessionResult; drops: string[] }
  | { ok: false; reason: string };

const STATES = new Set(["complete", "awaiting_human", "failed"]);
const FAILURE_REASONS = new Set<AgentFailureReason>([
  "agent_no_findings",
  "patch_validation_failed",
]);
const SEVERITIES = new Set(["SEV-1", "SEV-2", "SEV-3"]);
const ROOT_CAUSE_CONFIDENCES = new Set(["high", "medium", "low"]);
const NOISE_REASONS = new Set([
  "cosmetic_log_only",
  "lifecycle_signal",
  "self_telemetry",
  "expected_third_party",
  "confusing_log_no_impact",
]);
const RESOLUTION_REASONS = new Set([
  "fixed_in_current_code",
  "transient_condition_cleared",
  "upstream_recovered",
]);
const PR_OPEN_STATUSES = new Set(["pending", "opened"]);
const MOBILE_REGRESSION_TEST_STATUSES = new Set(["created", "skipped", "not_applicable"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function asConfidence(v: unknown): { text: string; confidence: number } | null {
  if (!isRecord(v)) return null;
  const text = asString(v.text);
  const confidence = v.confidence;
  if (text == null) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  // Clamp instead of reject — the agent occasionally overshoots the 0-10 range.
  const clamped = Math.max(0, Math.min(10, Math.round(confidence)));
  return { text, confidence: clamped };
}

function asNoiseClassification(v: unknown): IncidentNoiseClassification | null {
  if (!isRecord(v)) return null;
  const reason = asString(v.reason);
  const evidence = asString(v.evidence);
  if (reason == null || evidence == null) return null;
  if (!NOISE_REASONS.has(reason)) return null;
  return { reason: reason as IncidentNoiseClassification["reason"], evidence };
}

function asResolutionClassification(v: unknown): IncidentResolutionClassification | null {
  if (!isRecord(v)) return null;
  const reason = asString(v.reason);
  const evidence = asString(v.evidence);
  if (reason == null || evidence == null) return null;
  if (!RESOLUTION_REASONS.has(reason)) return null;
  return {
    reason: reason as IncidentResolutionClassification["reason"],
    evidence,
  };
}

function asMobileRegressionTest(v: unknown): AgentRunMobileRegressionTest | null {
  const parsed = parseStringifiedRecord(v);
  if (!isRecord(parsed)) return null;
  const status = asString(parsed.status);
  if (status == null || !MOBILE_REGRESSION_TEST_STATUSES.has(status)) return null;

  const testId = asString(parsed.testId);
  const url = asString(parsed.url);
  const reason = asString(parsed.reason);

  if (status === "created") {
    if (testId == null || testId.trim().length === 0) return null;
    return {
      status,
      testId,
      ...(url != null ? { url } : parsed.url === null ? { url: null } : {}),
      ...(reason != null ? { reason } : parsed.reason === null ? { reason: null } : {}),
    };
  }

  if (reason == null || reason.trim().length === 0) return null;
  return {
    status: status as "skipped" | "not_applicable",
    reason,
    ...(testId != null ? { testId } : parsed.testId === null ? { testId: null } : {}),
    ...(url != null ? { url } : parsed.url === null ? { url: null } : {}),
  };
}

function parseStringifiedRecord(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (!trimmed.startsWith("{")) return v;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Managed Agents sometimes stringify nested objects and append one extra
    // closing brace. Salvage the object when trimming only trailing braces
    // yields valid JSON; otherwise treat it as malformed.
    let candidate = trimmed;
    for (let i = 0; i < 3 && candidate.endsWith("}"); i++) {
      candidate = candidate.slice(0, -1).trimEnd();
      try {
        return JSON.parse(candidate);
      } catch {
        // Continue trying only the narrow trailing-brace repair.
      }
    }
    return v;
  }
}

function asPr(v: unknown): AgentRunPr | null {
  const parsed = parseStringifiedRecord(v);
  if (!isRecord(parsed)) return null;
  const selectedRepoFullName = asString(parsed.selectedRepoFullName);
  const branchName = asString(parsed.branchName);
  const baseBranch = asString(parsed.baseBranch);
  const validationPassed = asBool(parsed.validationPassed);
  const openStatus = asString(parsed.openStatus);
  if (
    selectedRepoFullName == null ||
    branchName == null ||
    baseBranch == null ||
    validationPassed == null ||
    openStatus == null ||
    !PR_OPEN_STATUSES.has(openStatus)
  ) {
    return null;
  }
  const pr: AgentRunPr = {
    selectedRepoFullName,
    branchName,
    baseBranch,
    validationPassed,
    openStatus: openStatus as AgentRunPr["openStatus"],
  };
  // Optional fields — keep what's valid, silently drop what isn't.
  const title = asString(parsed.title);
  if (title != null) pr.title = title;
  else if (parsed.title === null) pr.title = null;
  const body = asString(parsed.body);
  if (body != null) pr.body = body;
  else if (parsed.body === null) pr.body = null;
  const patchFileId = asString(parsed.patchFileId);
  if (patchFileId != null) pr.patchFileId = patchFileId;
  else if (parsed.patchFileId === null) pr.patchFileId = null;
  const patchFilePath = asString(parsed.patchFilePath);
  if (patchFilePath != null) pr.patchFilePath = patchFilePath;
  else if (parsed.patchFilePath === null) pr.patchFilePath = null;
  const validationCommands = asStringArray(parsed.validationCommands);
  if (validationCommands != null) pr.validationCommands = validationCommands;
  const validationSummary = asString(parsed.validationSummary);
  if (validationSummary != null) pr.validationSummary = validationSummary;
  else if (parsed.validationSummary === null) pr.validationSummary = null;
  const changedFiles = asStringArray(parsed.changedFiles);
  if (changedFiles != null) pr.changedFiles = changedFiles;
  const url = asString(parsed.url);
  if (url != null) pr.url = url;
  else if (parsed.url === null) pr.url = null;
  return pr;
}

function asLinearTicket(v: unknown): AgentRunLinearTicket | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const createdByAgent = asBool(v.createdByAgent);
  if (id == null || createdByAgent == null) return null;
  const ticket: AgentRunLinearTicket = { id, createdByAgent };
  const url = asString(v.url);
  if (url != null) ticket.url = url;
  else if (v.url === null) ticket.url = null;
  return ticket;
}

export function normalizeAgentResult(rawInput: unknown): NormalizeResult {
  if (!isRecord(rawInput)) {
    return { ok: false, reason: "input is not an object" };
  }
  const input: Record<string, unknown> = rawInput;

  const state = asString(input.state);
  if (state == null || !STATES.has(state)) {
    return {
      ok: false,
      reason: `invalid state: ${JSON.stringify(input.state)}`,
    };
  }
  const summary = asString(input.summary);
  if (summary == null) {
    return { ok: false, reason: "missing or non-string summary" };
  }

  const result: ManagedSessionResult = {
    state: state as ManagedSessionResult["state"],
    summary,
  };
  const drops: string[] = [];

  // Helper: assign a normalised value when the input had something but the
  // shape was wrong; assign null when the agent explicitly sent null.
  function take<K extends keyof ManagedSessionResult>(
    key: K,
    rawKey: string,
    value: ManagedSessionResult[K] | null,
  ) {
    const raw = input[rawKey];
    if (value !== null) {
      result[key] = value;
      return;
    }
    if (raw === null || raw === undefined) {
      // Agent explicitly omitted/nulled — fine, leave field unset.
      return;
    }
    // Agent sent something but it didn't validate — drop and report.
    drops.push(rawKey);
  }

  const question = asString(input.question);
  if (state === "awaiting_human" && (question == null || question.length === 0)) {
    return {
      ok: false,
      reason: "state=awaiting_human requires a non-empty question",
    };
  }
  take("question", "question", question);

  const failureReason = asString(input.failureReason);
  const validatedFailureReason =
    failureReason != null && FAILURE_REASONS.has(failureReason as AgentFailureReason)
      ? (failureReason as AgentFailureReason)
      : null;
  if (state === "failed" && validatedFailureReason == null) {
    return {
      ok: false,
      reason: "state=failed requires failureReason in {agent_no_findings, patch_validation_failed}",
    };
  }
  take("failureReason", "failureReason", validatedFailureReason);

  const proposedTitle = asString(input.proposedTitle);
  take("proposedTitle", "proposedTitle", proposedTitle);

  const rootCauseConfidence = asString(input.rootCauseConfidence);
  take(
    "rootCauseConfidence",
    "rootCauseConfidence",
    rootCauseConfidence != null && ROOT_CAUSE_CONFIDENCES.has(rootCauseConfidence)
      ? (rootCauseConfidence as "high" | "medium" | "low")
      : null,
  );

  take("rootCause", "rootCause", asConfidence(input.rootCause));
  take("estimatedImpact", "estimatedImpact", asConfidence(input.estimatedImpact));

  const severity = asString(input.severity);
  take(
    "severity",
    "severity",
    severity != null && SEVERITIES.has(severity) ? (severity as "SEV-1" | "SEV-2" | "SEV-3") : null,
  );

  take(
    "mobileRegressionTest",
    "mobileRegressionTest",
    asMobileRegressionTest(input.mobileRegressionTest),
  );

  take(
    "noiseClassification",
    "noiseClassification",
    asNoiseClassification(input.noiseClassification),
  );
  take(
    "resolutionClassification",
    "resolutionClassification",
    asResolutionClassification(input.resolutionClassification),
  );

  take("pr", "pr", asPr(input.pr));
  take("linearTicket", "linearTicket", asLinearTicket(input.linearTicket));

  return { ok: true, result, drops };
}
