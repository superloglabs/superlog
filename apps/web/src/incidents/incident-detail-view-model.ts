import type { AgentRun, Incident } from "../api.ts";

export type IncidentMetaRow = {
  label: string;
  value: string;
  kind?: "priority" | "status" | "environment" | "findings" | "agent";
  // Emphasis for the value (and its icon). "danger" (red) flags an
  // attention-worthy state like an out-of-credits investigation.
  tone?: "danger";
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
  agentRunState,
  pendingRecovery,
}: {
  incident: Incident;
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
    {
      label: "Investigation",
      value: agentRunLabel(agentRunState, incident),
      kind: "agent",
      tone:
        !agentRunState && incident.autoInvestigateBlockedReason === "no_credits"
          ? "danger"
          : undefined,
    },
  ];
}

// The "Agent run" row shows the live run state when there is one. With no run,
// it explains *why*: an org over its investigation limit reads "out of credits"
// (actionable — upgrade), everything else falls back to a plain "not queued".
export function agentRunLabel(
  agentRunState: AgentRun["state"] | null,
  incident: Pick<Incident, "autoInvestigateBlockedReason">,
): string {
  if (agentRunState) return agentRunState;
  if (incident.autoInvestigateBlockedReason === "no_credits") return "Out of credits";
  return "not queued";
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
