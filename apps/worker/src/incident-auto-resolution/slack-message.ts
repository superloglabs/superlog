export function buildQuietIncidentResolvedSlackMessage(input: {
  linkedIssueCount: number;
  quietSince: Date;
}): string {
  const fallback = `${input.quietSince.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const slackDate = `<!date^${Math.floor(input.quietSince.getTime() / 1000)}^{date_short_pretty} at {time}|${fallback}>`;
  const subject =
    input.linkedIssueCount === 1 ? "the linked error" : `${input.linkedIssueCount} linked errors`;
  return `:white_check_mark: Automatically resolved after 14 days without recurrence. Latest activity across ${subject} was ${slackDate}.`;
}
