export type IncidentStatusAction = {
  label: "Problem resolved" | "Not an issue" | "Reopen incident";
  targetStatus: "open" | "resolved";
  // Sent with status='resolved': problem_resolved marks the incident's issues
  // resolved (recurrence opens a new chained incident); not_an_issue silences
  // them (future occurrences are suppressed).
  resolution?: "problem_resolved" | "not_an_issue";
  variant: "secondary" | "ghost";
};

export function getIncidentStatusActions(status: string): IncidentStatusAction[] {
  if (status === "open") {
    return [
      {
        label: "Problem resolved",
        targetStatus: "resolved",
        resolution: "problem_resolved",
        variant: "secondary",
      },
      {
        label: "Not an issue",
        targetStatus: "resolved",
        resolution: "not_an_issue",
        variant: "ghost",
      },
    ];
  }
  return [
    {
      label: "Reopen incident",
      targetStatus: "open",
      variant: "ghost",
    },
  ];
}
