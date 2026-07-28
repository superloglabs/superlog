export type AwsDiagnosticStatus = "healthy" | "warning" | "error";
export type AwsDiagnosticCheckStatus = "pass" | "warning" | "fail";
export type AwsDiagnosticCheckKey = "role" | "stack" | "metrics" | "logs";
export type AwsDeliveryKind = "metrics" | "logs";

export type AwsDiagnosticFacts = {
  expectedAccountId: string | null;
  identityAccountId: string;
  stacks: Array<{ name: string; status: string }>;
  metricStream: { name: string; state: string } | null;
  deliveryStreams: Array<{
    kind: AwsDeliveryKind;
    name: string;
    status: string;
    recordsDelivered: number | null;
    minimumSuccessfulRecords: number | null;
  }>;
  logSubscriptionPolicyCount: number;
  deliveryErrors: Array<{
    kind: AwsDeliveryKind;
    code: string;
    occurredAt: string;
  }>;
  permissionGaps: string[];
};

export type AwsDiagnosticCheck = {
  key: AwsDiagnosticCheckKey;
  label: string;
  status: AwsDiagnosticCheckStatus;
  summary: string;
  evidence: Record<string, string | number | boolean | null>;
};

export type AwsDiagnosticResult = {
  status: AwsDiagnosticStatus;
  summary: string;
  checks: AwsDiagnosticCheck[];
};

export type AwsDiagnosticTarget = {
  connectionId: string;
  projectId: string;
  region: string;
  roleArn: string;
  externalId: string;
  expectedAccountId: string | null;
  requestedByUserId: string;
  reason: string | null;
};

export type AwsDiagnosticRunDraft = AwsDiagnosticResult & {
  connectionId: string;
  projectId: string;
  region: string;
  requestedByUserId: string;
  reason: string | null;
};

export type AwsDiagnosticRun = Omit<AwsDiagnosticRunDraft, "requestedByUserId"> & {
  id: string;
  requestedByUserId: string | null;
  createdAt: Date;
};

export interface AwsDiagnosticProbe {
  inspect(target: AwsDiagnosticTarget): Promise<AwsDiagnosticFacts>;
}

export interface AwsDiagnosticRecorder {
  record(run: AwsDiagnosticRunDraft): Promise<AwsDiagnosticRun>;
}

export class AwsDiagnosticProbeError extends Error {
  constructor(readonly code: string) {
    super("AWS diagnostics are unavailable");
    this.name = "AwsDiagnosticProbeError";
  }
}

const deliveryFor = (facts: AwsDiagnosticFacts, kind: AwsDeliveryKind) =>
  facts.deliveryStreams.find((stream) => stream.kind === kind) ?? null;

function deliveryCheck(kind: AwsDeliveryKind, facts: AwsDiagnosticFacts): AwsDiagnosticCheck {
  const delivery = deliveryFor(facts, kind);
  const errors = facts.deliveryErrors.filter((error) => error.kind === kind);
  const label = kind === "metrics" ? "CloudWatch metrics" : "CloudWatch logs";
  const hasSource =
    kind === "metrics"
      ? facts.metricStream?.state.toLowerCase() === "running"
      : facts.logSubscriptionPolicyCount > 0;

  if (!hasSource) {
    return {
      key: kind,
      label,
      status: "warning",
      summary:
        kind === "metrics"
          ? "No running CloudWatch metric stream was found."
          : "No account-level CloudWatch Logs subscription policy was found.",
      evidence: {
        sourceConfigured: false,
        deliveryStream: delivery?.name ?? null,
      },
    };
  }

  if (!delivery) {
    return {
      key: kind,
      label,
      status: "warning",
      summary: "The telemetry source exists, but its delivery stream was not found.",
      evidence: { sourceConfigured: true, deliveryStream: null },
    };
  }

  if (
    delivery.status !== "ACTIVE" ||
    delivery.minimumSuccessfulRecords === 0 ||
    errors.length > 0
  ) {
    return {
      key: kind,
      label,
      status: "fail",
      summary:
        errors.length > 0
          ? `AWS reported ${errors.length} recent delivery error${errors.length === 1 ? "" : "s"}.`
          : delivery.minimumSuccessfulRecords === 0
            ? "AWS reported a failed delivery attempt in the last hour."
            : `The delivery stream is ${delivery.status.toLowerCase()}.`,
      evidence: {
        sourceConfigured: true,
        deliveryStream: delivery.name,
        deliveryStatus: delivery.status,
        recordsDelivered: delivery.recordsDelivered,
        minimumSuccessfulRecords: delivery.minimumSuccessfulRecords,
        recentErrorCount: errors.length,
        latestErrorCode: errors.at(0)?.code ?? null,
      },
    };
  }

  if (delivery.recordsDelivered === 0) {
    return {
      key: kind,
      label,
      status: "warning",
      summary: "The AWS delivery path is active, but no records arrived in the last hour.",
      evidence: {
        sourceConfigured: true,
        deliveryStream: delivery.name,
        deliveryStatus: delivery.status,
        recordsDelivered: 0,
        minimumSuccessfulRecords: delivery.minimumSuccessfulRecords,
      },
    };
  }

  return {
    key: kind,
    label,
    status: "pass",
    summary: "The AWS source and delivery stream are active.",
    evidence: {
      sourceConfigured: true,
      deliveryStream: delivery.name,
      deliveryStatus: delivery.status,
      recordsDelivered: delivery.recordsDelivered,
      minimumSuccessfulRecords: delivery.minimumSuccessfulRecords,
    },
  };
}

export function evaluateAwsDiagnostics(facts: AwsDiagnosticFacts): AwsDiagnosticResult {
  const roleMatches =
    facts.expectedAccountId == null || facts.expectedAccountId === facts.identityAccountId;
  const role: AwsDiagnosticCheck = {
    key: "role",
    label: "Read-only AWS role",
    status: roleMatches ? "pass" : "fail",
    summary: roleMatches
      ? `The role is assumable in AWS account ${facts.identityAccountId}.`
      : "The assumed role belongs to a different AWS account.",
    evidence: {
      accountId: facts.identityAccountId,
      expectedAccountId: facts.expectedAccountId,
    },
  };

  let stack: AwsDiagnosticCheck;
  if (facts.stacks.length === 0) {
    stack = {
      key: "stack",
      label: "CloudFormation stack",
      status: "warning",
      summary: "The Superlog CloudFormation stack was not found in this region.",
      evidence: { found: false },
    };
  } else {
    const brokenStack = facts.stacks.find((candidate) =>
      /FAILED|ROLLBACK|DELETE/.test(candidate.status),
    );
    const incompleteStack = facts.stacks.find((candidate) => !/_COMPLETE$/.test(candidate.status));
    stack = {
      key: "stack",
      label: "CloudFormation stack",
      status: brokenStack ? "fail" : incompleteStack ? "warning" : "pass",
      summary: brokenStack
        ? `${brokenStack.name} is ${brokenStack.status}.`
        : incompleteStack
          ? `${incompleteStack.name} is ${incompleteStack.status}.`
          : `${facts.stacks.length} CloudFormation stack${facts.stacks.length === 1 ? " is" : "s are"} deployed.`,
      evidence: {
        found: true,
        stackCount: facts.stacks.length,
        problemStackName: brokenStack?.name ?? incompleteStack?.name ?? null,
        problemStackStatus: brokenStack?.status ?? incompleteStack?.status ?? null,
      },
    };
  }

  const checks = [role, stack, deliveryCheck("metrics", facts), deliveryCheck("logs", facts)];
  if (facts.permissionGaps.length > 0) {
    const affected = new Set(facts.permissionGaps);
    for (const check of checks) {
      if (check.status !== "fail" && (affected.has(check.key) || affected.has("diagnostics"))) {
        check.status = "warning";
        check.summary = "Update the AWS stack to enable this diagnostic check.";
        check.evidence = { ...check.evidence, permissionAvailable: false };
      }
    }
  }

  const status: AwsDiagnosticStatus = checks.some((check) => check.status === "fail")
    ? "error"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "healthy";

  return {
    status,
    summary:
      status === "healthy"
        ? "The AWS telemetry connection is healthy."
        : status === "warning"
          ? "The AWS connection needs attention."
          : "AWS reported a problem with the telemetry connection.",
    checks,
  };
}

function unavailableResult(error: unknown): AwsDiagnosticResult {
  const errorCode = error instanceof AwsDiagnosticProbeError ? error.code : "DiagnosticUnavailable";
  return {
    status: "error",
    summary: "Superlog could not inspect the AWS telemetry connection.",
    checks: [
      {
        key: "role",
        label: "Read-only AWS role",
        status: "fail",
        summary: "The diagnostic role could not be assumed.",
        evidence: { errorCode },
      },
      {
        key: "stack",
        label: "CloudFormation stack",
        status: "warning",
        summary: "This check could not run.",
        evidence: { checked: false },
      },
      {
        key: "metrics",
        label: "CloudWatch metrics",
        status: "warning",
        summary: "This check could not run.",
        evidence: { checked: false },
      },
      {
        key: "logs",
        label: "CloudWatch logs",
        status: "warning",
        summary: "This check could not run.",
        evidence: { checked: false },
      },
    ],
  };
}

export async function runAwsDiagnostics(
  target: AwsDiagnosticTarget,
  deps: { probe: AwsDiagnosticProbe; recorder: AwsDiagnosticRecorder },
): Promise<AwsDiagnosticRun> {
  let result: AwsDiagnosticResult;
  try {
    result = evaluateAwsDiagnostics(await deps.probe.inspect(target));
  } catch (error) {
    result = unavailableResult(error);
  }

  return deps.recorder.record({
    connectionId: target.connectionId,
    projectId: target.projectId,
    region: target.region,
    requestedByUserId: target.requestedByUserId,
    reason: target.reason,
    ...result,
  });
}
