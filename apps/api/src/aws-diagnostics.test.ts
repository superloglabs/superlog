import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type AwsDiagnosticFacts,
  AwsDiagnosticProbeError,
  type AwsDiagnosticRun,
  evaluateAwsDiagnostics,
  runAwsDiagnostics,
} from "./aws-diagnostics.js";

test("reports a healthy connection when the integration stack and both streams are active", () => {
  const result = evaluateAwsDiagnostics({
    expectedAccountId: "123456789012",
    identityAccountId: "123456789012",
    stacks: [{ name: "superlog-connect", status: "CREATE_COMPLETE" }],
    metricStream: { name: "superlog-metrics-abc1234", state: "running" },
    deliveryStreams: [
      {
        kind: "metrics",
        name: "superlog-metrics-abc1234",
        status: "ACTIVE",
        recordsDelivered: 18,
        minimumSuccessfulRecords: 18,
      },
      {
        kind: "logs",
        name: "superlog-logs-abc1234",
        status: "ACTIVE",
        recordsDelivered: 4,
        minimumSuccessfulRecords: 4,
      },
    ],
    logSubscriptionPolicyCount: 1,
    deliveryErrors: [],
    permissionGaps: [],
  });

  assert.equal(result.status, "healthy");
  assert.deepEqual(
    result.checks.map((check) => [check.key, check.status]),
    [
      ["role", "pass"],
      ["stack", "pass"],
      ["metrics", "pass"],
      ["logs", "pass"],
    ],
  );
  assert.match(result.summary, /healthy/i);
});

test("records an audited, sanitized result when the diagnostic role cannot be assumed", async () => {
  const recorded: AwsDiagnosticRun[] = [];

  const result = await runAwsDiagnostics(
    {
      connectionId: "connection-id",
      projectId: "project-id",
      region: "us-east-1",
      roleArn: "arn:aws:iam::123456789012:role/SuperlogScrape",
      externalId: "secret-external-id",
      expectedAccountId: "123456789012",
      requestedByUserId: "user-id",
      reason: "Customer requested help",
    },
    {
      probe: {
        async inspect() {
          throw new AwsDiagnosticProbeError("AccessDenied");
        },
      },
      recorder: {
        async record(run) {
          const saved = { ...run, id: "run-id", createdAt: new Date("2026-07-28T12:00:00Z") };
          recorded.push(saved);
          return saved;
        },
      },
    },
  );

  assert.equal(result.status, "error");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.requestedByUserId, "user-id");
  assert.equal(recorded[0]?.reason, "Customer requested help");
  assert.equal(recorded[0]?.checks[0]?.evidence.errorCode, "AccessDenied");
  assert.doesNotMatch(JSON.stringify(recorded[0]), /secret-external-id/);
  assert.doesNotMatch(JSON.stringify(recorded[0]), /arn:aws:iam/);
});

test("explains when an existing customer role needs the diagnostic permissions update", () => {
  const result = evaluateAwsDiagnostics({
    expectedAccountId: "123456789012",
    identityAccountId: "123456789012",
    stacks: [],
    metricStream: null,
    deliveryStreams: [],
    logSubscriptionPolicyCount: 0,
    deliveryErrors: [],
    permissionGaps: ["stack", "metrics", "logs"],
  });

  assert.equal(result.status, "warning");
  for (const check of result.checks.filter((candidate) => candidate.key !== "role")) {
    assert.match(check.summary, /update the AWS stack/i);
    assert.equal(check.evidence.permissionAvailable, false);
  }
});

test("flags a failed Firehose delivery attempt even when the stream is active", () => {
  const result = evaluateAwsDiagnostics({
    expectedAccountId: "123456789012",
    identityAccountId: "123456789012",
    stacks: [{ name: "superlog-connect", status: "CREATE_COMPLETE" }],
    metricStream: { name: "superlog-metrics-abc1234", state: "running" },
    deliveryStreams: [
      {
        kind: "metrics",
        name: "superlog-metrics-abc1234",
        status: "ACTIVE",
        recordsDelivered: 0,
        minimumSuccessfulRecords: 0,
      },
    ],
    logSubscriptionPolicyCount: 0,
    deliveryErrors: [],
    permissionGaps: [],
  });

  assert.equal(result.status, "error");
  assert.equal(result.checks.find((check) => check.key === "metrics")?.status, "fail");
  assert.match(
    result.checks.find((check) => check.key === "metrics")?.summary ?? "",
    /failed delivery attempt/i,
  );
});

test("fails the stack check when any stack in a legacy connection rolled back", () => {
  const result = evaluateAwsDiagnostics({
    expectedAccountId: "123456789012",
    identityAccountId: "123456789012",
    stacks: [
      { name: "superlog-connect", status: "CREATE_COMPLETE" },
      { name: "superlog-metrics-stream", status: "CREATE_COMPLETE" },
      { name: "superlog-logs-stream", status: "ROLLBACK_COMPLETE" },
    ],
    metricStream: { name: "superlog-metrics-abc1234", state: "running" },
    deliveryStreams: [],
    logSubscriptionPolicyCount: 0,
    deliveryErrors: [],
    permissionGaps: [],
  } satisfies AwsDiagnosticFacts);

  const stack = result.checks.find((check) => check.key === "stack");
  assert.equal(stack?.status, "fail");
  assert.match(stack?.summary ?? "", /superlog-logs-stream.*ROLLBACK_COMPLETE/);
});
