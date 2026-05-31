type WeekBuckets = {
  traces: number;
  incidents: number;
  prsOpened: number;
  prsMerged: number;
};

export type AdminOrgOverviewRow = {
  org: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    signupSource: string | null;
  };
  githubConnected: boolean;
  githubConnectedAt: string | null;
  slackConnected: boolean;
  slackConnectedAt: string | null;
  mcpConnected: boolean;
  mcpConnectedAt: string | null;
  members: { userId: string; email: string; name: string | null; joinedAt: string }[];
  thisWeek: WeekBuckets;
  prevWeek: WeekBuckets;
};

type DateLike = Date | string;

export type AdminOverviewSources = {
  loadOrgs(): Promise<
    {
      id: string;
      name: string;
      slug: string;
      createdAt: DateLike;
      signupSource: string | null;
    }[]
  >;
  loadGithubConnections(): Promise<{ orgId: string; connectedAt: DateLike }[]>;
  loadSlackConnections(): Promise<{ orgId: string; connectedAt: DateLike }[]>;
  loadMcpConnections(): Promise<{ orgId: string; connectedAt: DateLike }[]>;
  loadIncidentBuckets(): Promise<{ orgId: string; thisWeek: number; prevWeek: number }[]>;
  loadPrOpenedBuckets(): Promise<{ orgId: string; thisWeek: number; prevWeek: number }[]>;
  loadPrMergedBuckets(): Promise<{ orgId: string; thisWeek: number; prevWeek: number }[]>;
  loadTraceBuckets(
    signal: AbortSignal,
  ): Promise<{ orgId: string; thisWeek: number; prevWeek: number }[]>;
  loadMembers(): Promise<
    {
      orgId: string;
      userId: string;
      email: string;
      name: string | null;
      joinedAt: DateLike;
    }[]
  >;
};

export type BuildAdminOrgOverviewOptions = {
  traceTimeoutMs?: number;
  onTraceTelemetryUnavailable?: (reason: "timeout" | "error", error?: unknown) => void;
};

const DEFAULT_TRACE_TIMEOUT_MS = 2_500;

export function adminTraceIngestBucketsQuery(): string {
  return `
    WITH raw_samples AS (
      SELECT
        Attributes['tenant.org.id'] AS org_id,
        StartTimeUnix AS start_time,
        ResourceAttributes['service.instance.id'] AS service_instance_id,
        ResourceAttributes['process.pid'] AS process_pid,
        TimeUnix AS sample_time,
        toNullable(Value) AS value
      FROM otel_metrics_sum
      WHERE TimeUnix >= now() - INTERVAL 14 DAY
        AND MetricName = 'superlog.tenant.traces.received'
        AND Attributes['tenant.org.id'] != ''
    ),
    samples AS (
      SELECT
        org_id,
        start_time,
        service_instance_id,
        process_pid,
        sample_time,
        value,
        lagInFrame(value, 1, NULL) OVER (
          PARTITION BY org_id, start_time, service_instance_id, process_pid
          ORDER BY sample_time
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS prev_value
      FROM raw_samples
    ),
    deltas AS (
      SELECT
        org_id,
        sample_time,
        greatest(value - prev_value, 0) AS delta
      FROM samples
      WHERE prev_value IS NOT NULL
    )
    SELECT
      org_id,
      coalesce(sumIf(delta, sample_time >= now() - INTERVAL 7 DAY), 0) AS this_week,
      coalesce(sumIf(delta, sample_time >= now() - INTERVAL 14 DAY AND sample_time < now() - INTERVAL 7 DAY), 0) AS prev_week
    FROM deltas
    GROUP BY org_id
  `;
}

export async function buildAdminOrgOverview(
  sources: AdminOverviewSources,
  opts: BuildAdminOrgOverviewOptions = {},
): Promise<AdminOrgOverviewRow[]> {
  const traceBucketsPromise = loadTraceBucketsWithFallback(sources, opts);

  const [
    orgs,
    ghInstalls,
    slackInstalls,
    mcpConnectedOrgs,
    incidentBuckets,
    prsOpenedBuckets,
    prsMergedBuckets,
    traceBuckets,
    memberRows,
  ] = await Promise.all([
    sources.loadOrgs(),
    sources.loadGithubConnections(),
    sources.loadSlackConnections(),
    sources.loadMcpConnections(),
    sources.loadIncidentBuckets(),
    sources.loadPrOpenedBuckets(),
    sources.loadPrMergedBuckets(),
    traceBucketsPromise,
    sources.loadMembers(),
  ]);

  const githubByOrg = new Map(ghInstalls.map((r) => [r.orgId, r.connectedAt]));
  const slackByOrg = new Map(slackInstalls.map((r) => [r.orgId, r.connectedAt]));
  const mcpByOrg = new Map(mcpConnectedOrgs.map((r) => [r.orgId, r.connectedAt]));
  const membersByOrg = new Map<
    string,
    { userId: string; email: string; name: string | null; joinedAt: string }[]
  >();
  for (const m of memberRows) {
    const list = membersByOrg.get(m.orgId) ?? [];
    list.push({
      userId: m.userId,
      email: m.email,
      name: m.name ?? null,
      joinedAt: toIso(m.joinedAt),
    });
    membersByOrg.set(m.orgId, list);
  }
  for (const list of membersByOrg.values()) {
    list.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  const incidentsByOrg = new Map(incidentBuckets.map((r) => [r.orgId, r]));
  const prsOpenedByOrg = new Map(prsOpenedBuckets.map((r) => [r.orgId, r]));
  const prsMergedByOrg = new Map(prsMergedBuckets.map((r) => [r.orgId, r]));

  const tracesByOrg = new Map<string, { thisWeek: number; prevWeek: number }>();
  for (const row of traceBuckets) {
    const acc = tracesByOrg.get(row.orgId) ?? { thisWeek: 0, prevWeek: 0 };
    acc.thisWeek += Number(row.thisWeek);
    acc.prevWeek += Number(row.prevWeek);
    tracesByOrg.set(row.orgId, acc);
  }

  const result: AdminOrgOverviewRow[] = orgs.map((o) => {
    const traces = tracesByOrg.get(o.id) ?? { thisWeek: 0, prevWeek: 0 };
    const incidents = incidentsByOrg.get(o.id) ?? { thisWeek: 0, prevWeek: 0 };
    const opened = prsOpenedByOrg.get(o.id) ?? { thisWeek: 0, prevWeek: 0 };
    const merged = prsMergedByOrg.get(o.id) ?? { thisWeek: 0, prevWeek: 0 };
    const githubAt = githubByOrg.get(o.id) ?? null;
    const slackAt = slackByOrg.get(o.id) ?? null;
    const mcpAt = mcpByOrg.get(o.id) ?? null;
    return {
      org: {
        id: o.id,
        name: o.name,
        slug: o.slug,
        createdAt: toIso(o.createdAt),
        signupSource: o.signupSource ?? null,
      },
      githubConnected: githubAt !== null,
      githubConnectedAt: githubAt ? toIso(githubAt) : null,
      slackConnected: slackAt !== null,
      slackConnectedAt: slackAt ? toIso(slackAt) : null,
      mcpConnected: mcpAt !== null,
      mcpConnectedAt: mcpAt ? toIso(mcpAt) : null,
      members: membersByOrg.get(o.id) ?? [],
      thisWeek: {
        traces: traces.thisWeek,
        incidents: Number(incidents.thisWeek),
        prsOpened: Number(opened.thisWeek),
        prsMerged: Number(merged.thisWeek),
      },
      prevWeek: {
        traces: traces.prevWeek,
        incidents: Number(incidents.prevWeek),
        prsOpened: Number(opened.prevWeek),
        prsMerged: Number(merged.prevWeek),
      },
    };
  });

  result.sort((a, b) => score(b) - score(a));
  return result;
}

async function loadTraceBucketsWithFallback(
  sources: AdminOverviewSources,
  opts: BuildAdminOrgOverviewOptions,
): Promise<{ orgId: string; thisWeek: number; prevWeek: number }[]> {
  const controller = new AbortController();
  const timeoutMs = opts.traceTimeoutMs ?? DEFAULT_TRACE_TIMEOUT_MS;
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("admin trace telemetry timed out"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([sources.loadTraceBuckets(controller.signal), timeout]);
  } catch (err) {
    opts.onTraceTelemetryUnavailable?.(timedOut ? "timeout" : "error", err);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function score(r: AdminOrgOverviewRow) {
  return r.thisWeek.traces + r.thisWeek.incidents + r.thisWeek.prsOpened + r.thisWeek.prsMerged;
}

function toIso(value: DateLike): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
