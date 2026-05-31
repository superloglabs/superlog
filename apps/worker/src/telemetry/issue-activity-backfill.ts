import { fingerprint, fingerprintLog } from "@superlog/fingerprint";

export type TraceIssueActivityGroup = {
  project_id: string;
  day: string;
  exc_type: string;
  exc_message: string;
  exc_stack: string;
  c: string | number;
};

export type LogIssueActivityGroup = {
  project_id: string;
  day: string;
  service: string;
  severity: string;
  body: string;
  exc_type: string;
  exc_stack: string;
  c: string | number;
};

export type IssueActivityAggregate = {
  project_id: string;
  fingerprint: string;
  day: string;
  event_count: number;
};

export function aggregateTraceIssueActivity(
  rows: TraceIssueActivityGroup[],
): IssueActivityAggregate[] {
  const aggregates = new Map<string, IssueActivityAggregate>();
  for (const row of rows) {
    if (!row.project_id || !row.day) continue;
    const fp = fingerprint({
      type: row.exc_type || "Error",
      message: row.exc_message || null,
      stacktrace: row.exc_stack || null,
    });
    addAggregate(aggregates, row.project_id, fp.hash, row.day, row.c);
  }
  return [...aggregates.values()];
}

export function aggregateLogIssueActivity(rows: LogIssueActivityGroup[]): IssueActivityAggregate[] {
  const aggregates = new Map<string, IssueActivityAggregate>();
  for (const row of rows) {
    if (!row.project_id || !row.day) continue;
    const fp = fingerprintLog({
      service: row.service || "unknown",
      severity: row.severity || "ERROR",
      body: row.body || "",
      exceptionType: row.exc_type || null,
      stacktrace: row.exc_stack || null,
    });
    addAggregate(aggregates, row.project_id, fp.hash, row.day, row.c);
  }
  return [...aggregates.values()];
}

function addAggregate(
  aggregates: Map<string, IssueActivityAggregate>,
  projectId: string,
  hash: string,
  day: string,
  count: string | number,
): void {
  const key = `${projectId}\u0001${hash}\u0001${day}`;
  const existing = aggregates.get(key);
  if (existing) {
    existing.event_count += Number(count);
    return;
  }
  aggregates.set(key, {
    project_id: projectId,
    fingerprint: hash,
    day,
    event_count: Number(count),
  });
}
