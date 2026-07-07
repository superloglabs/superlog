export type ReferenceIncident = {
  id: string;
  projectId: string;
  codename: string;
  title: string;
  service: string;
  environment: string;
  severity: "SEV-1" | "SEV-2" | "SEV-3";
  status: "open" | "resolved";
  firstSeen: string;
  lastSeen: string;
  issueCount: number;
  agentSummary: string;
  rootCauseText: string;
  rootCauseConfidence: number;
  estimatedImpactText: string;
  slackChannelId: string | null;
  slackThreadTs: string | null;
};

export type ReferenceIssue = {
  id: string;
  kind: "log" | "trace";
  service: string;
  exceptionType: string;
  title: string;
  message: string;
  eventCount: number;
  traceId: string | null;
  spanId: string | null;
  seenAt: string;
  resourceInstance: string;
};

export type ReferenceAgentRun = {
  id: string;
  state: "complete" | "running" | "failed";
  runtime: string;
  selectedRepoFullName: string;
  startedAt: string;
  completedAt: string;
};

export type ReferenceIncidentDetail = {
  incident: ReferenceIncident;
  issue: ReferenceIssue;
  agentRun: ReferenceAgentRun;
};

export type ReferenceActivityKind =
  | "detected"
  | "status"
  | "finding"
  | "fact"
  | "assignment"
  | "priority"
  | "fix";

export type ReferenceActivityItem = {
  kind: ReferenceActivityKind;
  label: string;
  timeLabel: string;
  body: string;
  code?: {
    file: string;
    removed: string[];
    added: string[];
    context: string[];
  };
};

export const CLOUDFLARE_PREFLIGHT_DETAIL: ReferenceIncidentDetail = {
  incident: {
    id: "285160df-0e1c-4119-a481-4a54f2e5e72c",
    projectId: "b925b1df-5b78-43c8-a816-6f00afb174af",
    codename: "opal-tanuki",
    title: "Cloudflare integration setup fails — preflight check rejects OTLP intake",
    service: "superlog-api",
    environment: "production",
    severity: "SEV-2",
    status: "open",
    firstSeen: "2026-06-30T16:39:01.388Z",
    lastSeen: "2026-06-30T16:39:01.388Z",
    issueCount: 1,
    slackChannelId: "C0B8T8ZKMGV",
    slackThreadTs: "1782837579.126859",
    agentSummary:
      "Cloudflare Connect provisioning fails for all users because Cloudflare's synthetic preflight check to the OTLP intake is rejected, causing every destination creation to return 400.",
    rootCauseText:
      "The Cloudflare Workers Observability Destinations API performs a synthetic preflight HTTP request before creating a destination. The probe hits the OTLP intake without a valid x-api-key header or proper OTLP payload, so traces, logs, and metrics destinations all fail.",
    rootCauseConfidence: 8,
    estimatedImpactText:
      "Every user who clicks Connect Cloudflare and completes OAuth is redirected to the error state; the integration cannot be installed by anyone.",
  },
  issue: {
    id: "b08fa0b6-8888-4efd-aa84-e3e992e5ffdd",
    kind: "log",
    service: "superlog-api",
    exceptionType: "ERROR",
    title: "ERROR: cloudflare provisioning failed",
    message: "cloudflare provisioning failed",
    eventCount: 1,
    traceId: "37bdacb395b41b683917df3674f8a7b0",
    spanId: "784778a2160850fb",
    seenAt: "2026-06-30T16:39:01.388Z",
    resourceInstance: "ip-10-0-12-68.us-west-2.compute.internal",
  },
  agentRun: {
    id: "138e571a-a21b-4d66-a587-14dcabd94b2e",
    state: "complete",
    runtime: "anthropic",
    selectedRepoFullName: "superloglabs/superlog",
    startedAt: "2026-06-30T16:43:04.819Z",
    completedAt: "2026-06-30T17:01:30.633Z",
  },
};

export function buildReferenceActivity(detail: ReferenceIncidentDetail): ReferenceActivityItem[] {
  return [
    {
      kind: "detected",
      label: "Problem detected",
      timeLabel: "16:39 UTC",
      body: `${detail.issue.title}. Cloudflare OAuth completed, then provisioning failed before any telemetry destinations were created.`,
    },
    {
      kind: "status",
      label: "Status updated to Investigating",
      timeLabel: "16:43 UTC",
      body: "Investigation run started and selected the application repository for review.",
    },
    {
      kind: "finding",
      label: "Finding",
      timeLabel: "16:52 UTC",
      body: "Cloudflare's synthetic preflight probe is rejected by the OTLP intake. Add skipPreflightCheck: true when creating traces, logs, and metrics destinations.",
      code: {
        file: "apps/api/src/cloudflare-service.ts",
        removed: ["enabled: true,"],
        added: ["enabled: true,", "skipPreflightCheck: true,"],
        context: [
          "return {",
          "  name: `Superlog ${input.signal}`,",
          "  configuration: buildDestinationConfiguration(input),",
          "};",
        ],
      },
    },
    {
      kind: "fact",
      label: "Fact",
      timeLabel: "16:55 UTC",
      body: 'All 3 signal destinations returned HTTP 400, so provisionInstallation threw "cloudflare connect: no telemetry destinations were created".',
    },
    {
      kind: "assignment",
      label: "Assigned",
      timeLabel: "16:56 UTC",
      body: "Assigned to the integration owner for review.",
    },
    {
      kind: "priority",
      label: "Priority set to SEV-2",
      timeLabel: "16:57 UTC",
      body: "The Cloudflare integration cannot be installed by any user until destination creation succeeds.",
    },
    {
      kind: "fix",
      label: "Suggested fix",
      timeLabel: "17:01 UTC",
      body: "Skip Cloudflare's preflight check for OTLP destinations and thread the raw Cloudflare error array into WARN logs so failed provisioning is diagnosable next time.",
    },
  ];
}

export function referenceIncidentStats(detail: ReferenceIncidentDetail) {
  const durationMs =
    Date.parse(detail.agentRun.completedAt) - Date.parse(detail.incident.firstSeen);
  return {
    issueCountLabel: `${detail.incident.issueCount} finding${detail.incident.issueCount === 1 ? "" : "s"}`,
    durationLabel: formatDuration(durationMs),
    firstDetectionLabel: formatUtcTime(detail.incident.firstSeen),
    latestDetectionLabel: formatUtcTime(detail.incident.lastSeen),
  };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min ${seconds} s`;
}

function formatUtcTime(iso: string): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }).format(new Date(iso)) + " UTC"
  );
}
