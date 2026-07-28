import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type AwsDiagnosticClientFactory,
  createAwsDiagnosticProbe,
} from "./aws-diagnostics-aws.js";

const client = (respond: (commandName: string, command: object) => unknown) => ({
  async send(command: object) {
    return respond(command.constructor.name, command);
  },
});

test("the AWS probe returns structured delivery facts without retaining raw error logs", async () => {
  const assumeRoleInputs: Array<{ DurationSeconds?: number; Policy?: string }> = [];
  const factory: AwsDiagnosticClientFactory = {
    sts: () =>
      client((command, value) => {
        if (command === "AssumeRoleCommand") {
          assumeRoleInputs.push(
            (value as { input: { DurationSeconds?: number; Policy?: string } }).input,
          );
          return {
            Credentials: {
              AccessKeyId: "temporary-key",
              SecretAccessKey: "temporary-secret",
              SessionToken: "temporary-token",
            },
          };
        }
        return { Account: "123456789012" };
      }),
    cloudFormation: () =>
      client(() => ({
        Stacks: [{ StackName: "superlog-connect", StackStatus: "CREATE_COMPLETE" }],
      })),
    cloudWatch: () =>
      client((command) =>
        command === "ListMetricStreamsCommand"
          ? {
              Entries: [
                {
                  Name: "superlog-metrics-abcdef1-stream",
                  State: "running",
                },
              ],
            }
          : {
              MetricDataResults: [
                { Id: "metrics_records", Values: [12] },
                { Id: "metrics_success", Values: [12] },
                { Id: "logs_records", Values: [3] },
                { Id: "logs_success", Values: [3] },
              ],
            },
      ),
    firehose: () =>
      client((command) =>
        command === "ListDeliveryStreamsCommand"
          ? {
              DeliveryStreamNames: [
                "superlog-metrics-abcdef1-stream",
                "superlog-logs-abcdef1-stream",
              ],
            }
          : { DeliveryStreamDescription: { DeliveryStreamStatus: "ACTIVE" } },
      ),
    logs: () =>
      client((command) => {
        if (command === "DescribeAccountPoliciesCommand") {
          return { accountPolicies: [{ policyName: "superlog-logs-abcdef1-subscription" }] };
        }
        if (command === "DescribeLogStreamsCommand") {
          return { logStreams: [{ logStreamName: "HttpEndpointDelivery" }] };
        }
        return {
          events: [
            {
              timestamp: Date.parse("2026-07-28T10:00:00Z"),
              message: JSON.stringify({
                errorCode: "HttpEndpoint.DestinationException",
                errorMessage: "response included customer-secret-value",
              }),
            },
          ],
        };
      }),
  };
  const probe = createAwsDiagnosticProbe(factory);

  const facts = await probe.inspect({
    connectionId: "abcdef12-3456-7890-abcd-ef1234567890",
    projectId: "project-id",
    region: "us-east-1",
    roleArn: "arn:aws:iam::123456789012:role/SuperlogScrape",
    externalId: "external-id",
    expectedAccountId: "123456789012",
    requestedByUserId: "user-id",
    reason: null,
  });

  assert.equal(facts.identityAccountId, "123456789012");
  assert.equal(facts.stack?.status, "CREATE_COMPLETE");
  assert.equal(facts.metricStream?.name, "superlog-metrics-abcdef1-stream");
  assert.equal(facts.logSubscriptionPolicyCount, 1);
  assert.deepEqual(
    facts.deliveryStreams.map((stream) => [stream.kind, stream.recordsDelivered]),
    [
      ["metrics", 12],
      ["logs", 3],
    ],
  );
  assert.deepEqual(facts.deliveryErrors, [
    {
      kind: "metrics",
      code: "HttpEndpoint.DestinationException",
      occurredAt: "2026-07-28T10:00:00.000Z",
    },
    {
      kind: "logs",
      code: "HttpEndpoint.DestinationException",
      occurredAt: "2026-07-28T10:00:00.000Z",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(facts), /customer-secret-value/);
  assert.doesNotMatch(JSON.stringify(facts), /temporary-secret/);
  assert.equal(assumeRoleInputs[0]?.DurationSeconds, 900);
  assert.ok((assumeRoleInputs[0]?.Policy?.length ?? Number.POSITIVE_INFINITY) <= 2048);
  assert.doesNotMatch(assumeRoleInputs[0]?.Policy ?? "", /GetObject|GetSecretValue|Decrypt/);
});
