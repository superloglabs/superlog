import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricStreamsCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  DescribeAccountPoliciesCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DescribeDeliveryStreamCommand,
  FirehoseClient,
  ListDeliveryStreamsCommand,
} from "@aws-sdk/client-firehose";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  type AwsDeliveryKind,
  type AwsDiagnosticFacts,
  type AwsDiagnosticProbe,
  AwsDiagnosticProbeError,
  type AwsDiagnosticTarget,
} from "./aws-diagnostics.js";
import { streamResourcePrefix } from "./cloud-connections-service.js";

type TempCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

type DiagnosticClient = {
  send(command: object): Promise<unknown>;
};

type DiagnosticClientConfig = {
  region?: string;
  credentials?: TempCredentials;
};

export type AwsDiagnosticClientFactory = {
  sts(config?: DiagnosticClientConfig): DiagnosticClient;
  cloudFormation(config: DiagnosticClientConfig): DiagnosticClient;
  cloudWatch(config: DiagnosticClientConfig): DiagnosticClient;
  firehose(config: DiagnosticClientConfig): DiagnosticClient;
  logs(config: DiagnosticClientConfig): DiagnosticClient;
};

const wrapClient = (client: { send(command: never): Promise<unknown> }): DiagnosticClient => ({
  send: (command) => client.send(command as never),
});

const defaultFactory: AwsDiagnosticClientFactory = {
  sts: (config = {}) => wrapClient(new STSClient(config)),
  cloudFormation: (config) => wrapClient(new CloudFormationClient(config)),
  cloudWatch: (config) => wrapClient(new CloudWatchClient(config)),
  firehose: (config) => wrapClient(new FirehoseClient(config)),
  logs: (config) => wrapClient(new CloudWatchLogsClient(config)),
};

function roleIdentity(roleArn: string): { partition: string; accountId: string } {
  const match = /^arn:([^:]+):iam::(\d{12}):role\/.+$/.exec(roleArn);
  if (!match?.[1] || !match[2]) throw new AwsDiagnosticProbeError("InvalidRoleArn");
  return { partition: match[1], accountId: match[2] };
}

function diagnosticSessionPolicy(target: AwsDiagnosticTarget): string {
  const { partition, accountId } = roleIdentity(target.roleArn);
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "firehose:ListDeliveryStreams",
          "cloudwatch:ListMetricStreams",
          "cloudwatch:GetMetricData",
          "logs:DescribeAccountPolicies",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: "cloudformation:DescribeStacks",
        Resource: `arn:${partition}:cloudformation:${target.region}:${accountId}:stack/superlog-*/*`,
      },
      {
        Effect: "Allow",
        Action: "firehose:DescribeDeliveryStream",
        Resource: `arn:${partition}:firehose:${target.region}:${accountId}:deliverystream/superlog-*`,
      },
      {
        Effect: "Allow",
        Action: ["logs:DescribeLogStreams", "logs:GetLogEvents"],
        Resource: `arn:${partition}:logs:${target.region}:${accountId}:log-group:/aws/kinesisfirehose/superlog-*:*`,
      },
    ],
  });
}

function errorCode(error: unknown): string {
  const value = (error as { name?: unknown; Code?: unknown; code?: unknown } | null) ?? {};
  for (const candidate of [value.name, value.Code, value.code]) {
    if (typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate)) {
      return candidate;
    }
  }
  return "AwsDiagnosticError";
}

const isDenied = (error: unknown) => /AccessDenied|Unauthorized/.test(errorCode(error));

const isMissing = (error: unknown) => /ResourceNotFound|ValidationError/.test(errorCode(error));

async function assumeDiagnosticRole(
  target: AwsDiagnosticTarget,
  factory: AwsDiagnosticClientFactory,
): Promise<TempCredentials> {
  try {
    const output = (await factory.sts({ region: target.region }).send(
      new AssumeRoleCommand({
        RoleArn: target.roleArn,
        ExternalId: target.externalId,
        RoleSessionName: "superlog-diagnostics",
        DurationSeconds: 900,
        Policy: diagnosticSessionPolicy(target),
      }),
    )) as {
      Credentials?: {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        SessionToken?: string;
      };
    };
    const credentials = output.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw new AwsDiagnosticProbeError("MissingTemporaryCredentials");
    }
    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    };
  } catch (error) {
    if (error instanceof AwsDiagnosticProbeError) throw error;
    throw new AwsDiagnosticProbeError(errorCode(error));
  }
}

async function inspectIdentity(
  target: AwsDiagnosticTarget,
  credentials: TempCredentials,
  factory: AwsDiagnosticClientFactory,
): Promise<string> {
  try {
    const output = (await factory
      .sts({ region: target.region, credentials })
      .send(new GetCallerIdentityCommand({}))) as { Account?: string };
    if (!output.Account) throw new AwsDiagnosticProbeError("MissingCallerAccount");
    return output.Account;
  } catch (error) {
    if (error instanceof AwsDiagnosticProbeError) throw error;
    throw new AwsDiagnosticProbeError(errorCode(error));
  }
}

async function inspectStack(
  client: DiagnosticClient,
  permissionGaps: string[],
): Promise<AwsDiagnosticFacts["stack"]> {
  for (const stackName of ["superlog-connect", "superlog-metrics-stream", "superlog-logs-stream"]) {
    try {
      const output = (await client.send(new DescribeStacksCommand({ StackName: stackName }))) as {
        Stacks?: Array<{
          StackName?: string;
          StackStatus?: string;
        }>;
      };
      const stack = output.Stacks?.at(0);
      if (stack?.StackName && stack.StackStatus) {
        return { name: stack.StackName, status: stack.StackStatus };
      }
    } catch (error) {
      if (isMissing(error)) continue;
      if (isDenied(error)) {
        permissionGaps.push("stack");
        return null;
      }
      throw new AwsDiagnosticProbeError(errorCode(error));
    }
  }
  return null;
}

async function inspectMetricStream(
  client: DiagnosticClient,
  expectedName: string,
  permissionGaps: string[],
): Promise<AwsDiagnosticFacts["metricStream"]> {
  try {
    let nextToken: string | undefined;
    do {
      const output = (await client.send(
        new ListMetricStreamsCommand({ NextToken: nextToken }),
      )) as {
        Entries?: Array<{ Name?: string; State?: string }>;
        NextToken?: string;
      };
      const stream = output.Entries?.find((entry) => entry.Name === expectedName);
      if (stream?.Name && stream.State) return { name: stream.Name, state: stream.State };
      nextToken = output.NextToken;
    } while (nextToken);
    return null;
  } catch (error) {
    if (isDenied(error)) {
      permissionGaps.push("metrics");
      return null;
    }
    throw new AwsDiagnosticProbeError(errorCode(error));
  }
}

type DeliveryState = AwsDiagnosticFacts["deliveryStreams"][number];

async function inspectDeliveryStreams(
  client: DiagnosticClient,
  expected: Record<AwsDeliveryKind, string>,
  permissionGaps: string[],
): Promise<DeliveryState[]> {
  try {
    const names: string[] = [];
    let exclusiveStartDeliveryStreamName: string | undefined;
    let hasMore = false;
    do {
      const output = (await client.send(
        new ListDeliveryStreamsCommand({
          ExclusiveStartDeliveryStreamName: exclusiveStartDeliveryStreamName,
          Limit: 100,
        }),
      )) as { DeliveryStreamNames?: string[]; HasMoreDeliveryStreams?: boolean };
      names.push(...(output.DeliveryStreamNames ?? []));
      hasMore = Boolean(output.HasMoreDeliveryStreams);
      exclusiveStartDeliveryStreamName = names.at(-1);
    } while (hasMore && exclusiveStartDeliveryStreamName);

    const found = (Object.entries(expected) as Array<[AwsDeliveryKind, string]>).filter(
      ([, name]) => names.includes(name),
    );
    return Promise.all(
      found.map(async ([kind, name]) => {
        const output = (await client.send(
          new DescribeDeliveryStreamCommand({ DeliveryStreamName: name }),
        )) as { DeliveryStreamDescription?: { DeliveryStreamStatus?: string } };
        return {
          kind,
          name,
          status: output.DeliveryStreamDescription?.DeliveryStreamStatus ?? "UNKNOWN",
          recordsDelivered: null,
          minimumSuccessfulRecords: null,
        };
      }),
    );
  } catch (error) {
    if (isDenied(error)) {
      permissionGaps.push("metrics", "logs");
      return [];
    }
    throw new AwsDiagnosticProbeError(errorCode(error));
  }
}

async function inspectDeliveryMetrics(
  client: DiagnosticClient,
  streams: DeliveryState[],
  permissionGaps: string[],
): Promise<void> {
  if (streams.length === 0) return;
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);
    const queries = streams.flatMap((stream) => [
      {
        Id: `${stream.kind}_records`,
        MetricStat: {
          Metric: {
            Namespace: "AWS/Firehose",
            MetricName: "DeliveryToHttpEndpoint.Records",
            Dimensions: [{ Name: "DeliveryStreamName", Value: stream.name }],
          },
          Period: 300,
          Stat: "Sum",
        },
        ReturnData: true,
      },
      {
        Id: `${stream.kind}_success`,
        MetricStat: {
          Metric: {
            Namespace: "AWS/Firehose",
            MetricName: "DeliveryToHttpEndpoint.Success",
            Dimensions: [{ Name: "DeliveryStreamName", Value: stream.name }],
          },
          Period: 300,
          Stat: "Minimum",
        },
        ReturnData: true,
      },
    ]);
    const output = (await client.send(
      new GetMetricDataCommand({
        StartTime: startTime,
        EndTime: endTime,
        MetricDataQueries: queries,
      }),
    )) as { MetricDataResults?: Array<{ Id?: string; Values?: number[] }> };
    for (const stream of streams) {
      const records = output.MetricDataResults?.find(
        (result) => result.Id === `${stream.kind}_records`,
      )?.Values;
      const success = output.MetricDataResults?.find(
        (result) => result.Id === `${stream.kind}_success`,
      )?.Values;
      stream.recordsDelivered = records?.length
        ? records.reduce((total, value) => total + value, 0)
        : 0;
      stream.minimumSuccessfulRecords = success?.length ? Math.min(...success) : null;
    }
  } catch (error) {
    if (isDenied(error)) {
      permissionGaps.push("metrics", "logs");
      return;
    }
    throw new AwsDiagnosticProbeError(errorCode(error));
  }
}

async function inspectLogSubscription(
  client: DiagnosticClient,
  expectedPolicyName: string,
  permissionGaps: string[],
): Promise<number> {
  try {
    let nextToken: string | undefined;
    let count = 0;
    do {
      const output = (await client.send(
        new DescribeAccountPoliciesCommand({
          policyType: "SUBSCRIPTION_FILTER_POLICY",
          nextToken,
        }),
      )) as { accountPolicies?: Array<{ policyName?: string }>; nextToken?: string };
      count += (output.accountPolicies ?? []).filter(
        (policy) => policy.policyName === expectedPolicyName,
      ).length;
      nextToken = output.nextToken;
    } while (nextToken);
    return count;
  } catch (error) {
    if (isDenied(error)) {
      permissionGaps.push("logs");
      return 0;
    }
    throw new AwsDiagnosticProbeError(errorCode(error));
  }
}

function safeDeliveryError(message: string | undefined, timestamp: number | undefined) {
  let code = "UnknownDeliveryError";
  if (message) {
    try {
      const parsed = JSON.parse(message) as { errorCode?: unknown };
      if (
        typeof parsed.errorCode === "string" &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(parsed.errorCode)
      ) {
        code = parsed.errorCode;
      }
    } catch {
      // Persist no raw message when Firehose emits an unexpected format.
    }
  }
  return { code, occurredAt: new Date(timestamp ?? 0).toISOString() };
}

async function inspectDeliveryErrors(
  client: DiagnosticClient,
  prefixes: Record<AwsDeliveryKind, string>,
  permissionGaps: string[],
): Promise<AwsDiagnosticFacts["deliveryErrors"]> {
  const errors: AwsDiagnosticFacts["deliveryErrors"] = [];
  for (const [kind, prefix] of Object.entries(prefixes) as Array<[AwsDeliveryKind, string]>) {
    try {
      const logGroupName = `/aws/kinesisfirehose/${prefix}`;
      const streams = (await client.send(
        new DescribeLogStreamsCommand({
          logGroupName,
          logStreamNamePrefix: "HttpEndpointDelivery",
          limit: 1,
        }),
      )) as { logStreams?: Array<{ logStreamName?: string }> };
      const logStreamName = streams.logStreams?.at(0)?.logStreamName;
      if (!logStreamName) continue;
      const output = (await client.send(
        new GetLogEventsCommand({
          logGroupName,
          logStreamName,
          startTime: Date.now() - 60 * 60 * 1000,
          startFromHead: false,
          limit: 20,
        }),
      )) as { events?: Array<{ message?: string; timestamp?: number }> };
      errors.push(
        ...(output.events ?? []).slice(-5).map((event) => ({
          kind,
          ...safeDeliveryError(event.message, event.timestamp),
        })),
      );
    } catch (error) {
      if (isMissing(error)) continue;
      if (isDenied(error)) {
        permissionGaps.push(kind);
        continue;
      }
      throw new AwsDiagnosticProbeError(errorCode(error));
    }
  }
  return errors;
}

export function createAwsDiagnosticProbe(
  factory: AwsDiagnosticClientFactory = defaultFactory,
): AwsDiagnosticProbe {
  return {
    async inspect(target) {
      const credentials = await assumeDiagnosticRole(target, factory);
      const config = { region: target.region, credentials };
      const permissionGaps: string[] = [];
      const prefixes = {
        metrics: streamResourcePrefix("metrics", target.connectionId),
        logs: streamResourcePrefix("logs", target.connectionId),
      };
      const expectedDeliveryStreams = {
        metrics: `${prefixes.metrics}-stream`,
        logs: `${prefixes.logs}-stream`,
      };
      const [identityAccountId, stack, metricStream, deliveryStreams, logSubscriptionPolicyCount] =
        await Promise.all([
          inspectIdentity(target, credentials, factory),
          inspectStack(factory.cloudFormation(config), permissionGaps),
          inspectMetricStream(
            factory.cloudWatch(config),
            expectedDeliveryStreams.metrics,
            permissionGaps,
          ),
          inspectDeliveryStreams(factory.firehose(config), expectedDeliveryStreams, permissionGaps),
          inspectLogSubscription(
            factory.logs(config),
            `${prefixes.logs}-subscription`,
            permissionGaps,
          ),
        ]);
      await inspectDeliveryMetrics(factory.cloudWatch(config), deliveryStreams, permissionGaps);
      const deliveryErrors = await inspectDeliveryErrors(
        factory.logs(config),
        prefixes,
        permissionGaps,
      );
      return {
        expectedAccountId: target.expectedAccountId,
        identityAccountId,
        stack,
        metricStream,
        deliveryStreams,
        logSubscriptionPolicyCount,
        deliveryErrors,
        permissionGaps: [...new Set(permissionGaps)],
      };
    },
  };
}
