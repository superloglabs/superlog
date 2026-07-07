import type { AgentRun, Incident } from "../api.ts";

export type IncidentMetaRow = {
  label: string;
  value: string;
  kind?: "priority" | "status" | "environment" | "findings" | "agent";
};

export function incidentDisplayStatus(status: string, pendingRecovery: boolean): string {
  if (pendingRecovery) return "Recovery detected";
  if (status === "open") return "Active";
  if (status === "resolved") return "Resolved";
  if (status === "autoresolved_noise") return "Noise";
  return titleizeStatus(status);
}

export function formatIncidentDuration(firstSeen: string, lastSeen: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(lastSeen) - Date.parse(firstSeen)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${remainingSeconds} s`;
  return `${remainingSeconds} s`;
}

export function buildIncidentDetailMeta({
  incident,
  issueCount,
  agentRunState,
  pendingRecovery,
}: {
  incident: Incident;
  issueCount: number;
  agentRunState: AgentRun["state"] | null;
  pendingRecovery: boolean;
}): IncidentMetaRow[] {
  return [
    { label: "Priority", value: incident.severity ?? "Unset", kind: "priority" },
    {
      label: "Status",
      value: incidentDisplayStatus(incident.status, pendingRecovery),
      kind: "status",
    },
    { label: "Service", value: incident.service ?? "Unknown" },
    { label: "Environment", value: incident.environment ?? "Unknown", kind: "environment" },
    { label: "First detection", value: formatIncidentUtc(incident.firstSeen) },
    { label: "Latest detection", value: formatIncidentUtc(incident.lastSeen) },
    { label: "Duration", value: formatIncidentDuration(incident.firstSeen, incident.lastSeen) },
    { label: "Findings", value: formatFindingsCount(issueCount), kind: "findings" },
    { label: "Agent run", value: agentRunState ?? "not queued", kind: "agent" },
  ];
}

function formatFindingsCount(count: number): string {
  return `${count.toLocaleString()} finding${count === 1 ? "" : "s"}`;
}

function formatIncidentUtc(iso: string): string {
  const date = new Date(iso);
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  const day = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
  return `${month} ${day}, ${time} UTC`;
}

function titleizeStatus(status: string): string {
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
