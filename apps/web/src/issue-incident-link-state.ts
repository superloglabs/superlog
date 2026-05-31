import type { Issue } from "./api.ts";

export type IssueIncidentLinkState = "pending" | "standalone" | "failed" | "loading" | "linked";

export function getIssueIncidentLinkState(opts: {
  groupingState: Issue["groupingState"];
  incident: { id: string } | null | undefined;
  isLoading: boolean;
}): IssueIncidentLinkState {
  if (opts.incident) return "linked";
  if (opts.groupingState === "pending") return "pending";
  if (opts.groupingState === "standalone") return "standalone";
  if (opts.groupingState === "failed") return "failed";
  return opts.isLoading ? "loading" : "standalone";
}
