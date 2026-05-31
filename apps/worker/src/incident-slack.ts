export type ReopenedIncidentQueueStatus =
  | "queued"
  | "existing_active"
  | "suppressed"
  | "disabled";

export function buildReopenedIncidentSlackUpdate(opts: {
  issueTitle: string;
  queueStatus: ReopenedIncidentQueueStatus;
}): {
  threadSummary: string;
  rootStatus: string;
  rootTagline: string;
} {
  const threadLines = [
    `:rotating_light: Incident reopened because linked issue regressed: *${opts.issueTitle}*`,
  ];

  switch (opts.queueStatus) {
    case "queued":
      threadLines.push(":mag: Investigation queued.");
      return {
        threadSummary: threadLines.join("\n"),
        rootStatus: "Incident reopened · investigation queued",
        rootTagline: `Linked issue regressed: ${opts.issueTitle}`,
      };
    case "existing_active":
      threadLines.push(":mag: Investigation already in progress.");
      return {
        threadSummary: threadLines.join("\n"),
        rootStatus: "Incident reopened · investigation ongoing",
        rootTagline: `Linked issue regressed: ${opts.issueTitle}`,
      };
    case "suppressed":
      threadLines.push(
        ":pause_button: Auto-investigation is temporarily suppressed because the last resolution was fixed in current code.",
      );
      return {
        threadSummary: threadLines.join("\n"),
        rootStatus: "Incident reopened",
        rootTagline: `Linked issue regressed: ${opts.issueTitle}`,
      };
    case "disabled":
    default:
      return {
        threadSummary: threadLines.join("\n"),
        rootStatus: "Incident reopened",
        rootTagline: `Linked issue regressed: ${opts.issueTitle}`,
      };
  }
}
