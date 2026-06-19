import { randomBytes } from "node:crypto";

/**
 * Generate the external ID used in the cross-account role's trust policy. This is
 * the confused-deputy guard: the customer's role only trusts our account when the
 * caller presents this exact value, so it must be unguessable and unique per
 * connection. base64url, no padding.
 */
export function generateExternalId(): string {
  return randomBytes(32).toString("base64url");
}

export type QuickCreateUrlInput = {
  /** Region the stack is created in. Metric streams / Firehose are regional. */
  region: string;
  /** Public HTTPS URL of the CloudFormation template (e.g. served from S3). */
  templateUrl: string;
  /** Default stack name shown to the user (they can change it). */
  stackName: string;
  /** CloudFormation parameter values; each is sent as `param_<Key>`. */
  params: Record<string, string>;
};

/**
 * Build a CloudFormation "Launch Stack" quick-create console link. The console
 * keeps its SPA routing + stack parameters in the URL fragment, so everything
 * after the host lives in the hash. Values are URL-encoded.
 *
 * The prod account ID is passed as a *parameter value* (not baked into the
 * template), so the committed template stays free of prod specifics.
 */
/** AWS region codes are lowercase letters, digits, and hyphens — nothing else. */
export const AWS_REGION_RE = /^[a-z0-9-]{1,32}$/;

export function buildConnectQuickCreateUrl(input: QuickCreateUrlInput): string {
  // `region` is interpolated into the hostname; reject anything that could break
  // out of `<region>.console.aws.amazon.com` and point the link at another host.
  if (!AWS_REGION_RE.test(input.region)) {
    throw new Error(`invalid region: ${input.region}`);
  }
  const base = `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(
    input.region,
  )}`;

  const frag = new URLSearchParams();
  frag.set("templateURL", input.templateUrl);
  frag.set("stackName", input.stackName);
  for (const [key, value] of Object.entries(input.params)) {
    frag.set(`param_${key}`, value);
  }

  return `${base}#/stacks/quickcreate?${frag.toString()}`;
}

export type StreamLaunchInput = {
  /** Region the stream + Firehose are created in (regional resources). */
  region: string;
  /** Public HTTPS URL of the stream's CloudFormation template. */
  templateUrl: string;
  /** Firehose intake URL records are delivered to (a proxy /aws/firehose/* route). */
  intakeUrl: string;
  /** The project's `sl_public_*` ingest key the stream authenticates with. */
  ingestKey: string;
  /** Connection this stack belongs to (passed through for later reporting). */
  connectionId: string;
};

/**
 * Build the "Launch Stack" link for a streaming stack (metrics or logs). The
 * intake URL and ingest key are stack *parameter values*, so neither the
 * template nor this code bakes in any prod specifics. Reuses the same
 * quick-create console-link shape as the baseline connect stack.
 */
function buildStreamLaunchUrl(stackName: string, input: StreamLaunchInput): string {
  return buildConnectQuickCreateUrl({
    region: input.region,
    templateUrl: input.templateUrl,
    stackName,
    params: {
      IntakeUrl: input.intakeUrl,
      IngestKey: input.ingestKey,
      ConnectionId: input.connectionId,
    },
  });
}

/** Launch link for `superlog-metrics-stream.cfn.yaml` (CloudWatch Metric Streams). */
export function buildMetricsStreamLaunchUrl(input: StreamLaunchInput): string {
  return buildStreamLaunchUrl("superlog-metrics-stream", input);
}

/** Launch link for `superlog-logs-stream.cfn.yaml` (account-level Logs subscription). */
export function buildLogsStreamLaunchUrl(input: StreamLaunchInput): string {
  return buildStreamLaunchUrl("superlog-logs-stream", input);
}

export type CombinedConnectLaunchInput = {
  /** Region the stack (and its regional stream/Firehose resources) is created in. */
  region: string;
  /** Public HTTPS URL of the combined `superlog-connect-stack.cfn.yaml` template. */
  templateUrl: string;
  /** Superlog AWS account id allowed to assume the scrape role. */
  superlogAccountId: string;
  /** Confused-deputy nonce for the scrape role's trust policy. */
  externalId: string;
  /** Connection this stack completes (zero-paste callback + reporting). */
  connectionId: string;
  /** Our SNS topic ARN for zero-paste reporting. Omitted → manual role-ARN paste. */
  serviceToken?: string;
  /** Firehose intake URLs (proxy `/aws/firehose/*` routes). */
  metricsIntakeUrl: string;
  logsIntakeUrl: string;
  /** Dedicated per-signal ingest keys the two Firehoses authenticate with. */
  metricsIngestKey: string;
  logsIngestKey: string;
  /** Stream toggles — default on. Off connects inventory only / skips that signal. */
  enableMetrics?: boolean;
  enableLogs?: boolean;
  /** CloudWatch Logs filter pattern (default everything). */
  logsFilterPattern?: string;
};

/**
 * Build the one-step "Connect AWS" launch link for the combined stack
 * (`superlog-connect-stack.cfn.yaml`): scrape role + metric streaming + log
 * streaming in a single CloudFormation stack named `superlog-connect`. Streaming
 * defaults on but each signal toggles off via a parameter. Everything
 * prod-specific (account id, intake URLs, ingest keys, SNS topic) is a parameter
 * value, never baked into the committed template.
 */
export function buildCombinedConnectLaunchUrl(input: CombinedConnectLaunchInput): string {
  const params: Record<string, string> = {
    SuperlogAccountId: input.superlogAccountId,
    ExternalId: input.externalId,
    ConnectionId: input.connectionId,
    EnableMetrics: (input.enableMetrics ?? true) ? "true" : "false",
    EnableLogs: (input.enableLogs ?? true) ? "true" : "false",
    MetricsIntakeUrl: input.metricsIntakeUrl,
    LogsIntakeUrl: input.logsIntakeUrl,
    MetricsIngestKey: input.metricsIngestKey,
    LogsIngestKey: input.logsIngestKey,
  };
  if (input.serviceToken) params.SuperlogServiceToken = input.serviceToken;
  if (input.logsFilterPattern) params.LogsFilterPattern = input.logsFilterPattern;
  return buildConnectQuickCreateUrl({
    region: input.region,
    templateUrl: input.templateUrl,
    stackName: "superlog-connect",
    params,
  });
}

/**
 * Name of the dedicated ingest key minted for a stream. Stable + regional so the
 * streaming-status read can find the key that the setup route created — keep the
 * two in lockstep by always going through this helper.
 */
export function streamKeyName(kind: "metrics" | "logs", region: string): string {
  return `AWS ${kind === "metrics" ? "metric" : "log"} stream (${region})`;
}

// Default window for "records are still arriving". CloudWatch metric streams
// deliver continuously for active resources, so a gap beyond this means the
// stream has gone quiet (torn down, throttled, or no matching resources) — we
// soften that to "no data recently" rather than a hard error to avoid alarming
// genuinely-idle accounts.
export const STREAM_FRESHNESS_MS = 15 * 60 * 1000;

/** One reconciled piece of the AWS integration stack. */
export type StackComponentState = "missing" | "pending" | "working" | "broken";
export interface StackComponent {
  key: "connection" | "metrics" | "logs";
  label: string;
  state: StackComponentState;
  /** Human-readable status line (the UI may append a relative time). */
  detail: string;
  /** Last delivery for the stream components (ISO); null for the connection / no data. */
  lastReceivedAt: string | null;
}
export interface StackHealth {
  components: StackComponent[];
}

export interface StackHealthInput {
  connection: {
    status: string;
    accountId: string | null;
    region: string;
    lastError: string | null;
  };
  /** The connection's persisted stream keys + their live delivery timestamp. */
  streams: { kind: "metrics" | "logs"; lastUsedAt: Date | null }[];
  now: Date;
  freshnessMs?: number;
}

/**
 * Reconcile the integration stack into a per-component checklist: which pieces
 * are in place, which are missing, which are working. Lightweight by design —
 * everything comes from the connection's verify state plus the stream keys'
 * delivery signal, so no AWS calls are needed.
 */
export function deriveStackHealth(input: StackHealthInput): StackHealth {
  const fresh = input.freshnessMs ?? STREAM_FRESHNESS_MS;
  const conn = input.connection;

  const connection: StackComponent = (() => {
    if (conn.status === "connected") {
      const who = conn.accountId ? `${conn.accountId} · ` : "";
      return {
        key: "connection",
        label: "Account connection",
        state: "working",
        detail: `Connected · ${who}${conn.region}`,
        lastReceivedAt: null,
      };
    }
    if (conn.status === "pending") {
      return {
        key: "connection",
        label: "Account connection",
        state: "pending",
        detail: "Awaiting stack deploy",
        lastReceivedAt: null,
      };
    }
    return {
      key: "connection",
      label: "Account connection",
      state: "broken",
      detail:
        conn.lastError ??
        (conn.status === "account_mismatch"
          ? "Connected account doesn't match the role"
          : "Couldn't assume the role"),
      lastReceivedAt: null,
    };
  })();

  const streamComponent = (kind: "metrics" | "logs", label: string): StackComponent => {
    const s = input.streams.find((x) => x.kind === kind);
    if (!s) {
      return { key: kind, label, state: "missing", detail: "Not set up", lastReceivedAt: null };
    }
    if (!s.lastUsedAt) {
      return {
        key: kind,
        label,
        state: "pending",
        detail: "Set up — waiting for first data",
        lastReceivedAt: null,
      };
    }
    const iso = s.lastUsedAt.toISOString();
    const fresh_ = input.now.getTime() - s.lastUsedAt.getTime() <= fresh;
    return {
      key: kind,
      label,
      state: fresh_ ? "working" : "pending",
      detail: fresh_ ? "Active" : "No data recently",
      lastReceivedAt: iso,
    };
  };

  return {
    components: [
      connection,
      streamComponent("metrics", "Metric streaming"),
      streamComponent("logs", "Log streaming"),
    ],
  };
}

/** Pull the 12-digit account id out of a role ARN, or null if it isn't one. */
export function parseAccountIdFromRoleArn(arn: string): string | null {
  const m = /^arn:aws[a-z-]*:iam::(\d{12}):role\/.+$/.exec(arn);
  return m?.[1] ?? null;
}

/**
 * Port: assume the cross-account role with the external ID and resolve the caller
 * identity. The real adapter wraps @aws-sdk/client-sts (AssumeRole +
 * GetCallerIdentity); tests pass a fake. Throws if the role can't be assumed
 * (stack not deployed yet, trust/externalId wrong, etc.).
 */
export type StsVerifier = {
  verifyAssumeRole(input: {
    roleArn: string;
    externalId: string;
  }): Promise<{ accountId: string }>;
};

export type VerifyResult =
  | { status: "connected"; accountId: string }
  | { status: "account_mismatch"; accountId: string; expectedAccountId: string }
  | { status: "failed"; reason: string };

/**
 * Health-check a connection: assume the role and confirm the resolved account
 * matches the one named in the role ARN. Never throws — a failure to assume is a
 * normal "not connected yet" state the UI renders, not an error.
 */
export async function verifyConnection(
  input: { roleArn: string; externalId: string },
  sts: StsVerifier,
): Promise<VerifyResult> {
  const expectedAccountId = parseAccountIdFromRoleArn(input.roleArn);
  try {
    const { accountId } = await sts.verifyAssumeRole(input);
    if (expectedAccountId && accountId !== expectedAccountId) {
      return { status: "account_mismatch", accountId, expectedAccountId };
    }
    return { status: "connected", accountId };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
