export type IncidentStats = {
  windowDays: number;
  buckets: { day: string; count: number }[];
  totalEvents: number;
  impactedUsers: number;
  impactedUsersAvailable: boolean;
};

export type IncidentStatsIssue = {
  eventCount: number;
  lastSeen: Date | string;
};

export type IncidentStatsActivityRow = {
  day: string;
  count: number | string;
};

export type IncidentStatsFingerprintIssue = {
  id: string;
  kind: string;
  service: string | null;
  exceptionType: string;
  lastSample?: {
    traceId?: string | null;
    spanId?: string | null;
    spanName?: string | null;
  } | null;
};

export type IncidentStatsPairs = {
  namedSpanServices: string[];
  namedSpanNames: string[];
  namedSpanExcTypes: string[];
  unnamedSpanServices: string[];
  unnamedSpanExcTypes: string[];
  logServices: string[];
  logExcTypes: string[];
};

export type BuildIncidentStatsFromIssuesOptions = {
  now?: Date;
  windowDays: number;
};

export type BuildIncidentStatsWithFallbackOptions = {
  fallback: IncidentStats;
  timeoutMs: number;
  loadTelemetry(signal: AbortSignal): Promise<IncidentStats>;
  onTelemetryUnavailable?: (reason: "timeout" | "error", error?: unknown) => void;
};

export function emptyIncidentStats(windowDays: number, now = new Date()): IncidentStats {
  return {
    windowDays,
    buckets: buildBucketsFromMap(new Map(), windowDays, now),
    totalEvents: 0,
    impactedUsers: 0,
    impactedUsersAvailable: false,
  };
}

export function buildIncidentStatsFromIssues(
  issues: IncidentStatsIssue[],
  opts: BuildIncidentStatsFromIssuesOptions,
): IncidentStats {
  const countsByDay = new Map<string, number>();
  const windowStart = startOfUtcDay(opts.now ?? new Date());
  windowStart.setUTCDate(windowStart.getUTCDate() - opts.windowDays + 1);

  for (const issue of issues) {
    const seenAt = issue.lastSeen instanceof Date ? issue.lastSeen : new Date(issue.lastSeen);
    if (!Number.isFinite(seenAt.getTime()) || seenAt < windowStart) continue;
    const day = toUtcDay(seenAt);
    countsByDay.set(day, (countsByDay.get(day) ?? 0) + Number(issue.eventCount));
  }

  const buckets = buildBucketsFromMap(countsByDay, opts.windowDays, opts.now);
  return {
    windowDays: opts.windowDays,
    buckets,
    totalEvents: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    impactedUsers: 0,
    impactedUsersAvailable: false,
  };
}

export function buildIncidentStatsFromActivityRows(
  rows: IncidentStatsActivityRow[],
  opts: BuildIncidentStatsFromIssuesOptions,
): IncidentStats {
  const countsByDay = new Map<string, number>();
  for (const row of rows) {
    countsByDay.set(row.day, (countsByDay.get(row.day) ?? 0) + Number(row.count));
  }

  const buckets = buildBucketsFromMap(countsByDay, opts.windowDays, opts.now);
  return {
    windowDays: opts.windowDays,
    buckets,
    totalEvents: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    impactedUsers: 0,
    impactedUsersAvailable: false,
  };
}

export function buildIncidentStatsPairs(
  issues: IncidentStatsFingerprintIssue[],
  spanNamesBySample: Map<string, string>,
): IncidentStatsPairs {
  const pairs: IncidentStatsPairs = {
    namedSpanServices: [],
    namedSpanNames: [],
    namedSpanExcTypes: [],
    unnamedSpanServices: [],
    unnamedSpanExcTypes: [],
    logServices: [],
    logExcTypes: [],
  };
  const seenNamedSpan = new Set<string>();
  const seenUnnamedSpan = new Set<string>();
  const seenLog = new Set<string>();

  for (const issue of issues) {
    const svc = issue.service ?? "";
    const et = issue.exceptionType ?? "";
    if (issue.kind === "log") {
      const key = pairKey(svc, et);
      if (seenLog.has(key)) continue;
      seenLog.add(key);
      pairs.logServices.push(svc);
      pairs.logExcTypes.push(et);
      continue;
    }

    const spanName = spanNameForIssue(issue, spanNamesBySample);
    if (spanName) {
      const key = pairKey(svc, spanName, et);
      if (seenNamedSpan.has(key)) continue;
      seenNamedSpan.add(key);
      pairs.namedSpanServices.push(svc);
      pairs.namedSpanNames.push(spanName);
      pairs.namedSpanExcTypes.push(et);
      continue;
    }

    const key = pairKey(svc, et);
    if (seenUnnamedSpan.has(key)) continue;
    seenUnnamedSpan.add(key);
    pairs.unnamedSpanServices.push(svc);
    pairs.unnamedSpanExcTypes.push(et);
  }

  return pairs;
}

export async function buildIncidentStatsWithFallback(
  opts: BuildIncidentStatsWithFallbackOptions,
): Promise<IncidentStats> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("incident stats telemetry timed out"));
    }, opts.timeoutMs);
  });

  try {
    return await Promise.race([opts.loadTelemetry(controller.signal), timeout]);
  } catch (err) {
    opts.onTelemetryUnavailable?.(timedOut ? "timeout" : "error", err);
    return opts.fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildBucketsFromMap(
  countsByDay: Map<string, number>,
  windowDays: number,
  now = new Date(),
): { day: string; count: number }[] {
  const buckets: { day: string; count: number }[] = [];
  const today = startOfUtcDay(now);
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = toUtcDay(d);
    buckets.push({ day: key, count: countsByDay.get(key) ?? 0 });
  }
  return buckets;
}

function startOfUtcDay(value: Date): Date {
  const out = new Date(value);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function toUtcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function spanNameForIssue(
  issue: IncidentStatsFingerprintIssue,
  spanNamesBySample: Map<string, string>,
): string | null {
  if (issue.lastSample?.spanName) return issue.lastSample.spanName;
  const traceId = issue.lastSample?.traceId;
  const spanId = issue.lastSample?.spanId;
  if (!traceId || !spanId) return null;
  return spanNamesBySample.get(spanSampleKey(traceId, spanId)) ?? null;
}

export function spanSampleKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`;
}

function pairKey(...parts: string[]): string {
  return parts.join("\u0001");
}
