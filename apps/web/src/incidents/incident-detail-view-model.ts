import type { AgentRun, Incident } from "../api.ts";

export function latestIncidentLinearTicket<T extends { createdAt: string }>(
  tickets: T[],
): T | null {
  return tickets.reduce<T | null>(
    (latest, ticket) =>
      !latest || Date.parse(ticket.createdAt) > Date.parse(latest.createdAt) ? ticket : latest,
    null,
  );
}

export type IncidentMetaRow = {
  label: string;
  value: string;
  /** Exact value shown on hover; timestamp rows use the visitor's locale and zone. */
  title?: string;
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
  now = Date.now(),
}: {
  incident: Incident;
  agentRunState: AgentRun["state"] | null;
  pendingRecovery: boolean;
  now?: number;
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
    {
      label: "First detection",
      value: formatIncidentRelative(incident.firstSeen, now),
      title: formatIncidentLocalTimestamp(incident.firstSeen),
    },
    {
      label: "Last detection",
      value: formatIncidentRelative(incident.lastSeen, now),
      title: formatIncidentLocalTimestamp(incident.lastSeen),
    },
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

export function formatIncidentRelative(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatIncidentLocalTimestamp(
  iso: string,
  options: { locale?: string; timeZone?: string } = {},
): string {
  return new Intl.DateTimeFormat(options.locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: options.timeZone,
  }).format(new Date(iso));
}

function titleizeStatus(status: string): string {
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
