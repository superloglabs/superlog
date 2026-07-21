import crypto from "node:crypto";

export type SentryIssueAction = "created" | "unresolved";

export type SentryIssue = {
  id: string;
  title: string;
  culprit: string | null;
  level: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  count: number;
  url: string | null;
  projectSlug: string;
};

export type SentryIssueEvent = {
  action: SentryIssueAction;
  installationId: string;
  rawBody: string;
  issue: SentryIssue;
};

export function hasValidSentrySignature(args: {
  rawBody: string;
  signature: string;
  clientSecret: string;
}): boolean {
  const expected = crypto
    .createHmac("sha256", args.clientSecret)
    .update(args.rawBody)
    .digest("hex");
  const providedBuffer = Buffer.from(args.signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export function parseSentryIssueEvent(rawBody: string): SentryIssueEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  if (payload.action !== "created" && payload.action !== "unresolved") return null;
  const installation = payload.installation;
  const data = payload.data;
  if (!isRecord(installation) || !isRecord(data) || !isRecord(data.issue)) return null;
  const issue = data.issue;
  const project = issue.project;
  if (
    typeof installation.uuid !== "string" ||
    typeof issue.id !== "string" ||
    typeof issue.title !== "string" ||
    !isRecord(project) ||
    typeof project.slug !== "string"
  ) {
    return null;
  }

  return {
    action: payload.action,
    installationId: installation.uuid,
    rawBody,
    issue: {
      id: issue.id,
      title: issue.title,
      culprit: stringOrNull(issue.culprit),
      level: stringOrNull(issue.level),
      firstSeen: stringOrNull(issue.firstSeen),
      lastSeen: stringOrNull(issue.lastSeen),
      count: finiteNumber(issue.count) ?? 0,
      url: stringOrNull(issue.permalink) ?? stringOrNull(issue.web_url),
      projectSlug: project.slug,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
