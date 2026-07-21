import type { Issue } from "../api.ts";

export type IssueStatusFilter = Issue["status"] | "all";
export type IssueListWindow = "12d" | "all";

export type IssueListFilter = {
  status: IssueStatusFilter;
  window: IssueListWindow;
};

export const DEFAULT_ISSUE_LIST_FILTER: IssueListFilter = {
  status: "open",
  window: "12d",
};

export const ISSUE_STATUS_TABS: { id: IssueStatusFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "under_observation", label: "Observing" },
  { id: "resolved", label: "Resolved" },
  { id: "silenced", label: "Silenced" },
  { id: "all", label: "All" },
];

export function issueListSearchParams(filter: IssueListFilter): URLSearchParams {
  return new URLSearchParams({
    status: filter.status,
    recentDays: filter.window === "12d" ? "12" : "all",
  });
}
