import { buildBucketsFromMap } from "../incidents/stats.js";

export const DEFAULT_ISSUE_LIST_WINDOW_DAYS = 12;

export type IssueListWindow = { days: number | null };

export type IssueListSource = {
  id: string;
  fingerprint: string;
  eventCount: number;
  lastSeen: Date | string;
};

export type IssueActivityRow = {
  fingerprint: string;
  day: string;
  count: number | string;
};

export function parseIssueListWindow(value: string | undefined): IssueListWindow {
  if (value === undefined) return { days: DEFAULT_ISSUE_LIST_WINDOW_DAYS };
  if (value === "all") return { days: null };

  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error("recentDays must be 'all' or between 1 and 90 days");
  }
  return { days };
}

export function buildIssueListItems<T extends IssueListSource>(
  issues: T[],
  activityRows: IssueActivityRow[],
  opts: { windowDays: number; now?: Date; activityAvailable?: boolean },
): (T & { activityBuckets: { day: string; count: number }[] })[] {
  const activityByFingerprint = new Map<string, Map<string, number>>();
  for (const row of activityRows) {
    const counts = activityByFingerprint.get(row.fingerprint) ?? new Map<string, number>();
    counts.set(row.day, (counts.get(row.day) ?? 0) + Number(row.count));
    activityByFingerprint.set(row.fingerprint, counts);
  }

  return issues.map((issue) => ({
    ...issue,
    activityBuckets:
      opts.activityAvailable === false
        ? []
        : buildBucketsFromMap(
            activityByFingerprint.get(issue.fingerprint) ?? new Map(),
            opts.windowDays,
            opts.now,
          ),
  }));
}
