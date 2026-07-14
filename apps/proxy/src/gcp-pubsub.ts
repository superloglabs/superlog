type OtlpAnyValue = {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
};

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

type GcpLogEntry = Record<string, unknown> & {
  logName?: unknown;
  resource?: unknown;
  timestamp?: unknown;
  receiveTimestamp?: unknown;
  severity?: unknown;
  textPayload?: unknown;
  jsonPayload?: unknown;
  protoPayload?: unknown;
  trace?: unknown;
  spanId?: unknown;
  traceSampled?: unknown;
  labels?: unknown;
  insertId?: unknown;
  httpRequest?: unknown;
};

type PubSubPush = {
  message?: { data?: unknown; messageId?: unknown; publishTime?: unknown; attributes?: unknown };
  subscription?: unknown;
};

export type GcpIdTokenVerifier = {
  verify(input: { idToken: string; audience: string }): Promise<{
    email: string | null;
    emailVerified: boolean;
  }>;
};

export async function authenticateGcpPubSubPush(input: {
  authorization: string | null | undefined;
  audience: string;
  serviceAccountEmail: string;
  verifier: GcpIdTokenVerifier;
}): Promise<void> {
  const match = /^Bearer\s+(.+)$/i.exec(input.authorization ?? "");
  if (!match?.[1]) throw new Error("missing Pub/Sub push bearer token");
  const identity = await input.verifier.verify({ idToken: match[1], audience: input.audience });
  if (!identity.emailVerified) throw new Error("Pub/Sub push identity email is not verified");
  if (identity.email !== input.serviceAccountEmail) {
    throw new Error("Pub/Sub push token has an unexpected service account");
  }
}

export type GcpOtlpLogsExport = {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{
      scope: { name: string };
      logRecords: Array<{
        timeUnixNano: string;
        observedTimeUnixNano: string;
        severityText: string;
        severityNumber: number;
        traceId?: string;
        spanId?: string;
        flags?: number;
        body: OtlpAnyValue;
        attributes: OtlpKeyValue[];
      }>;
    }>;
  }>;
};

const SEVERITY_NUMBER: Record<string, number> = {
  DEFAULT: 0,
  DEBUG: 5,
  INFO: 9,
  NOTICE: 10,
  WARNING: 13,
  ERROR: 17,
  CRITICAL: 18,
  ALERT: 21,
  EMERGENCY: 22,
};

export function gcpPubSubLogToOtlp(body: Buffer, expectedGcpProjectId: string): GcpOtlpLogsExport {
  const push = parseObject(
    JSON.parse(body.toString("utf8")),
    "invalid Pub/Sub push envelope",
  ) as PubSubPush;
  if (!push.message || typeof push.message.data !== "string") {
    throw new Error("Pub/Sub push envelope has no message data");
  }
  const decoded = Buffer.from(push.message.data, "base64").toString("utf8");
  const entry = parseObject(JSON.parse(decoded), "invalid Cloud Logging entry") as GcpLogEntry;
  const entryProjectId = projectIdOf(entry);
  if (entryProjectId !== expectedGcpProjectId) {
    throw new Error("Cloud Logging entry does not belong to connected project");
  }

  const resource = objectOrEmpty(entry.resource);
  const resourceType = stringOrEmpty(resource.type);
  const resourceLabels = objectOrEmpty(resource.labels);
  const serviceName =
    firstString(
      resourceLabels.service_name,
      resourceLabels.container_name,
      resourceLabels.function_name,
      resourceLabels.cluster_name,
      resourceLabels.instance_id,
    ) ||
    resourceType ||
    "gcp";
  const severityText = stringOrEmpty(entry.severity).toUpperCase();

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            kv("service.name", serviceName),
            kv("telemetry.source", "gcp"),
            kv("cloud.provider", "gcp"),
            kv("cloud.account.id", expectedGcpProjectId),
            kv("gcp.project.id", expectedGcpProjectId),
            kv("gcp.resource.type", resourceType),
            ...Object.entries(resourceLabels).map(([key, value]) =>
              kv(`gcp.resource.label.${key}`, value),
            ),
          ].filter(isKv),
        },
        scopeLogs: [
          {
            scope: { name: "gcp.cloud_logging" },
            logRecords: [
              {
                timeUnixNano: timestampToNanos(entry.timestamp),
                observedTimeUnixNano: timestampToNanos(
                  entry.receiveTimestamp ?? push.message.publishTime,
                ),
                severityText,
                severityNumber: SEVERITY_NUMBER[severityText] ?? 0,
                traceId: trailingHex(entry.trace, 32),
                spanId: exactHex(entry.spanId, 16),
                flags: entry.traceSampled === true ? 1 : 0,
                body: { stringValue: logBody(entry) },
                attributes: [
                  kv("gcp.insert_id", entry.insertId),
                  kv("gcp.log_name", entry.logName),
                  kv("gcp.pubsub.message_id", push.message.messageId),
                  kv("gcp.pubsub.subscription", push.subscription),
                  ...prefixedAttributes("gcp.label", entry.labels),
                  ...prefixedAttributes("gcp.http_request", entry.httpRequest),
                ].filter(isKv),
              },
            ],
          },
        ],
      },
    ],
  };
}

function parseObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function projectIdOf(entry: GcpLogEntry): string | null {
  if (typeof entry.logName === "string") {
    const match = /^projects\/([^/]+)\/logs\//.exec(entry.logName);
    if (match?.[1]) return match[1];
  }
  const labels = objectOrEmpty(objectOrEmpty(entry.resource).labels);
  return typeof labels.project_id === "string" ? labels.project_id : null;
}

function logBody(entry: GcpLogEntry): string {
  if (typeof entry.textPayload === "string") return entry.textPayload;
  if (entry.jsonPayload !== undefined) return stringify(entry.jsonPayload);
  if (entry.protoPayload !== undefined) return stringify(entry.protoPayload);
  return stringify(entry);
}

function timestampToNanos(value: unknown): string {
  if (typeof value !== "string") return "0";
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match?.[1]) return "0";
  const seconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(seconds)) return "0";
  const fraction = (match[2] ?? "").padEnd(9, "0").slice(0, 9);
  return String(BigInt(Math.trunc(seconds / 1000)) * 1_000_000_000n + BigInt(fraction || "0"));
}

function trailingHex(value: unknown, length: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const tail = value.split("/").at(-1);
  return tail && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(tail) ? tail.toLowerCase() : undefined;
}

function exactHex(value: unknown, length: number): string | undefined {
  return typeof value === "string" && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)
    ? value.toLowerCase()
    : undefined;
}

function prefixedAttributes(prefix: string, value: unknown): OtlpKeyValue[] {
  return Object.entries(objectOrEmpty(value))
    .map(([key, item]) => kv(`${prefix}.${key}`, item))
    .filter(isKv);
}

function kv(key: string, value: unknown): OtlpKeyValue | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: stringify(value) } };
}

function isKv(value: OtlpKeyValue | null): value is OtlpKeyValue {
  return value !== null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string {
  return (
    values.find((value): value is string => typeof value === "string" && value.length > 0) ?? ""
  );
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
