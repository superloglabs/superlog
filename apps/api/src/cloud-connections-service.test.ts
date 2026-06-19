import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type StsVerifier,
  buildCombinedConnectLaunchUrl,
  buildConnectQuickCreateUrl,
  buildLogsStreamLaunchUrl,
  buildMetricsStreamLaunchUrl,
  deriveStackHealth,
  generateExternalId,
  parseAccountIdFromRoleArn,
  streamKeyName,
  verifyConnection,
} from "./cloud-connections-service.js";

test("generateExternalId produces unguessable, url-safe, unique ids", () => {
  const a = generateExternalId();
  const b = generateExternalId();
  assert.notEqual(a, b);
  // high-entropy, url-safe (base64url alphabet), no padding
  assert.match(a, /^[A-Za-z0-9_-]{40,}$/);
});

test("buildConnectQuickCreateUrl builds a CloudFormation quick-create console link", () => {
  const url = buildConnectQuickCreateUrl({
    region: "us-west-2",
    templateUrl: "https://superlog-cfn.s3.amazonaws.com/aws-connect.yaml",
    stackName: "superlog-connect",
    params: {
      ExternalId: "ext-123",
      SuperlogAccountId: "123456789012",
      IngestKey: "sl_public_abc",
      IntakeUrl: "https://intake.example.com/aws/firehose",
    },
  });

  const u = new URL(url);
  assert.equal(u.host, "us-west-2.console.aws.amazon.com");
  assert.equal(u.pathname, "/cloudformation/home");
  assert.equal(u.searchParams.get("region"), "us-west-2");

  // The console keeps its routing + stack params in the fragment.
  assert.ok(u.hash.startsWith("#/stacks/quickcreate?"), `hash was ${u.hash}`);
  const frag = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1));
  assert.equal(frag.get("templateURL"), "https://superlog-cfn.s3.amazonaws.com/aws-connect.yaml");
  assert.equal(frag.get("stackName"), "superlog-connect");
  assert.equal(frag.get("param_ExternalId"), "ext-123");
  assert.equal(frag.get("param_SuperlogAccountId"), "123456789012");
  assert.equal(frag.get("param_IngestKey"), "sl_public_abc");
  assert.equal(frag.get("param_IntakeUrl"), "https://intake.example.com/aws/firehose");
});

test("buildConnectQuickCreateUrl rejects a region that could hijack the hostname", () => {
  assert.throws(() =>
    buildConnectQuickCreateUrl({
      region: "evil.com/x",
      templateUrl: "https://cfn.example/t.yaml",
      stackName: "s",
      params: {},
    }),
  );
  assert.throws(() =>
    buildConnectQuickCreateUrl({
      region: "us-west-2.attacker.com",
      templateUrl: "https://cfn.example/t.yaml",
      stackName: "s",
      params: {},
    }),
  );
});

test("buildMetricsStreamLaunchUrl carries intake URL, ingest key, and connection id", () => {
  const url = buildMetricsStreamLaunchUrl({
    region: "us-west-2",
    templateUrl: "https://superlog-cfn.s3.amazonaws.com/metrics-stream.yaml",
    intakeUrl: "https://intake.example.com/aws/firehose/metrics",
    ingestKey: "sl_public_abc123",
    connectionId: "conn-7",
  });

  const u = new URL(url);
  assert.equal(u.host, "us-west-2.console.aws.amazon.com");
  assert.ok(u.hash.startsWith("#/stacks/quickcreate?"), `hash was ${u.hash}`);
  const frag = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1));
  assert.equal(
    frag.get("templateURL"),
    "https://superlog-cfn.s3.amazonaws.com/metrics-stream.yaml",
  );
  assert.equal(frag.get("stackName"), "superlog-metrics-stream");
  assert.equal(frag.get("param_IntakeUrl"), "https://intake.example.com/aws/firehose/metrics");
  assert.equal(frag.get("param_IngestKey"), "sl_public_abc123");
  assert.equal(frag.get("param_ConnectionId"), "conn-7");
});

test("buildLogsStreamLaunchUrl targets the logs stack with the same params", () => {
  const url = buildLogsStreamLaunchUrl({
    region: "eu-central-1",
    templateUrl: "https://superlog-cfn.s3.amazonaws.com/logs-stream.yaml",
    intakeUrl: "https://intake.example.com/aws/firehose/logs",
    ingestKey: "sl_public_xyz",
    connectionId: "conn-9",
  });
  const u = new URL(url);
  const frag = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1));
  assert.equal(frag.get("stackName"), "superlog-logs-stream");
  assert.equal(frag.get("param_IntakeUrl"), "https://intake.example.com/aws/firehose/logs");
  assert.equal(frag.get("param_IngestKey"), "sl_public_xyz");
  assert.equal(frag.get("param_ConnectionId"), "conn-9");
});

test("buildCombinedConnectLaunchUrl carries scrape + both streams in one stack", () => {
  const url = buildCombinedConnectLaunchUrl({
    region: "us-west-2",
    templateUrl: "https://superlog-cfn.s3.amazonaws.com/connect-stack.yaml",
    superlogAccountId: "123456789012",
    externalId: "ext-abc",
    connectionId: "conn-1",
    serviceToken: "arn:aws:sns:us-west-2:123456789012:superlog-connect",
    metricsIntakeUrl: "https://intake.example.com/aws/firehose/metrics",
    logsIntakeUrl: "https://intake.example.com/aws/firehose/logs",
    metricsIngestKey: "sl_public_metrics",
    logsIngestKey: "sl_public_logs",
  });

  const u = new URL(url);
  assert.equal(u.host, "us-west-2.console.aws.amazon.com");
  const frag = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1));
  // One stack — same name as the baseline connect stack.
  assert.equal(frag.get("stackName"), "superlog-connect");
  assert.equal(frag.get("templateURL"), "https://superlog-cfn.s3.amazonaws.com/connect-stack.yaml");
  assert.equal(frag.get("param_SuperlogAccountId"), "123456789012");
  assert.equal(frag.get("param_ExternalId"), "ext-abc");
  assert.equal(frag.get("param_ConnectionId"), "conn-1");
  assert.equal(
    frag.get("param_SuperlogServiceToken"),
    "arn:aws:sns:us-west-2:123456789012:superlog-connect",
  );
  // Streaming on by default, both intake URLs + dedicated keys present.
  assert.equal(frag.get("param_EnableMetrics"), "true");
  assert.equal(frag.get("param_EnableLogs"), "true");
  assert.equal(
    frag.get("param_MetricsIntakeUrl"),
    "https://intake.example.com/aws/firehose/metrics",
  );
  assert.equal(frag.get("param_LogsIntakeUrl"), "https://intake.example.com/aws/firehose/logs");
  assert.equal(frag.get("param_MetricsIngestKey"), "sl_public_metrics");
  assert.equal(frag.get("param_LogsIngestKey"), "sl_public_logs");
});

test("buildCombinedConnectLaunchUrl can disable a stream and pass a log filter", () => {
  const url = buildCombinedConnectLaunchUrl({
    region: "eu-central-1",
    templateUrl: "https://cfn.example/connect-stack.yaml",
    superlogAccountId: "123456789012",
    externalId: "ext-xyz",
    connectionId: "conn-2",
    metricsIntakeUrl: "https://intake.example.com/aws/firehose/metrics",
    logsIntakeUrl: "https://intake.example.com/aws/firehose/logs",
    metricsIngestKey: "sl_public_m",
    logsIngestKey: "sl_public_l",
    enableMetrics: false,
    logsFilterPattern: "?ERROR ?WARN",
  });
  const frag = new URLSearchParams(new URL(url).hash.slice(new URL(url).hash.indexOf("?") + 1));
  assert.equal(frag.get("param_EnableMetrics"), "false");
  assert.equal(frag.get("param_EnableLogs"), "true");
  assert.equal(frag.get("param_LogsFilterPattern"), "?ERROR ?WARN");
  // No SNS topic supplied → no zero-paste param (manual paste fallback).
  assert.equal(frag.get("param_SuperlogServiceToken"), null);
});

test("buildMetricsStreamLaunchUrl rejects a hostname-hijacking region", () => {
  assert.throws(() =>
    buildMetricsStreamLaunchUrl({
      region: "us-west-2.attacker.com",
      templateUrl: "https://cfn.example/t.yaml",
      intakeUrl: "https://intake.example.com/aws/firehose/metrics",
      ingestKey: "sl_public_abc",
      connectionId: "c",
    }),
  );
});

test("streamKeyName matches the names the setup route mints", () => {
  assert.equal(streamKeyName("metrics", "us-west-2"), "AWS metric stream (us-west-2)");
  assert.equal(streamKeyName("logs", "eu-central-1"), "AWS log stream (eu-central-1)");
});

const NOW = new Date("2026-06-18T12:00:00.000Z");
const byKey = (h: ReturnType<typeof deriveStackHealth>, key: string) =>
  h.components.find((c) => c.key === key);

test("deriveStackHealth: fresh stack — connection working, streams missing", () => {
  const h = deriveStackHealth({
    connection: {
      status: "connected",
      accountId: "210987654321",
      region: "us-west-2",
      lastError: null,
    },
    streams: [],
    now: NOW,
  });
  assert.equal(byKey(h, "connection")?.state, "working");
  assert.match(byKey(h, "connection")?.detail ?? "", /210987654321/);
  assert.equal(byKey(h, "metrics")?.state, "missing");
  assert.equal(byKey(h, "logs")?.state, "missing");
});

test("deriveStackHealth: configured-but-no-data is pending; recent data is working", () => {
  const h = deriveStackHealth({
    connection: { status: "connected", accountId: "1", region: "us-west-2", lastError: null },
    streams: [
      { kind: "metrics", lastUsedAt: new Date(NOW.getTime() - 2 * 60 * 1000) }, // 2m ago
      { kind: "logs", lastUsedAt: null }, // set up, nothing yet
    ],
    now: NOW,
  });
  const m = byKey(h, "metrics");
  assert.equal(m?.state, "working");
  assert.equal(m?.lastReceivedAt, new Date(NOW.getTime() - 2 * 60 * 1000).toISOString());
  assert.equal(byKey(h, "logs")?.state, "pending");
});

test("deriveStackHealth: a stream gone quiet past the freshness window is pending, not working", () => {
  const h = deriveStackHealth({
    connection: { status: "connected", accountId: "1", region: "us-west-2", lastError: null },
    streams: [{ kind: "metrics", lastUsedAt: new Date(NOW.getTime() - 60 * 60 * 1000) }], // 1h ago
    now: NOW,
  });
  const m = byKey(h, "metrics");
  assert.equal(m?.state, "pending");
  assert.match(m?.detail ?? "", /no data/i);
  assert.ok(m?.lastReceivedAt, "still reports the last-received time");
});

test("deriveStackHealth: a failed/mismatched connection is broken with a reason", () => {
  const mismatch = deriveStackHealth({
    connection: {
      status: "account_mismatch",
      accountId: null,
      region: "us-west-2",
      lastError: null,
    },
    streams: [],
    now: NOW,
  });
  assert.equal(byKey(mismatch, "connection")?.state, "broken");

  const failed = deriveStackHealth({
    connection: {
      status: "failed",
      accountId: null,
      region: "us-west-2",
      lastError: "AccessDenied",
    },
    streams: [],
    now: NOW,
  });
  assert.equal(byKey(failed, "connection")?.state, "broken");
  assert.equal(byKey(failed, "connection")?.detail, "AccessDenied");
});

test("deriveStackHealth: a pending connection awaits stack deploy", () => {
  const h = deriveStackHealth({
    connection: { status: "pending", accountId: null, region: "us-west-2", lastError: null },
    streams: [],
    now: NOW,
  });
  assert.equal(byKey(h, "connection")?.state, "pending");
});

test("parseAccountIdFromRoleArn extracts the account id, null on garbage", () => {
  assert.equal(
    parseAccountIdFromRoleArn("arn:aws:iam::123456789012:role/SuperlogScrape"),
    "123456789012",
  );
  assert.equal(parseAccountIdFromRoleArn("not-an-arn"), null);
  assert.equal(parseAccountIdFromRoleArn("arn:aws:iam::short:role/x"), null);
});

const ROLE_ARN = "arn:aws:iam::123456789012:role/SuperlogScrape";

test("verifyConnection returns connected + accountId when assume-role succeeds", async () => {
  const sts: StsVerifier = {
    async verifyAssumeRole(input) {
      assert.equal(input.roleArn, ROLE_ARN);
      assert.equal(input.externalId, "ext-xyz");
      return { accountId: "123456789012" };
    },
  };
  const result = await verifyConnection({ roleArn: ROLE_ARN, externalId: "ext-xyz" }, sts);
  assert.deepEqual(result, { status: "connected", accountId: "123456789012" });
});

test("verifyConnection returns failed (not throw) when assume-role is denied", async () => {
  const sts: StsVerifier = {
    async verifyAssumeRole() {
      throw new Error("AccessDenied: not authorized to assume role");
    },
  };
  const result = await verifyConnection({ roleArn: ROLE_ARN, externalId: "ext-xyz" }, sts);
  assert.equal(result.status, "failed");
});

test("verifyConnection flags account mismatch between ARN and caller identity", async () => {
  const sts: StsVerifier = {
    async verifyAssumeRole() {
      // role assumed, but identity resolves to a different account
      return { accountId: "999999999999" };
    },
  };
  const result = await verifyConnection({ roleArn: ROLE_ARN, externalId: "ext-xyz" }, sts);
  assert.equal(result.status, "account_mismatch");
});
