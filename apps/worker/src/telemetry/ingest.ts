import { performance } from "node:perf_hooks";
import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { type DB, type IssueSample, db as defaultDb, schema } from "@superlog/db";
import {
  type Fingerprint,
  fingerprint,
  fingerprintLog,
  sanitizeForPg,
} from "@superlog/fingerprint";
import { inArray, sql } from "drizzle-orm";
import { logger } from "../logger.js";

const tracer = trace.getTracer("@superlog/worker");
const meter = metrics.getMeter("@superlog/worker/telemetry-ingest");
const SPAN_CURSOR = "fingerprint";
const LOG_CURSOR = "fingerprint-logs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_CURSOR = "1970-01-01 00:00:00.000000";
const DEFAULT_DISCOVERY_WINDOW_MS = 5 * 60 * 1000;

type TelemetryKind = "span" | "log";
type Clock = () => Date;

const batchRows = meter.createCounter("superlog.worker.telemetry.batch_rows", {
  description: "Telemetry rows selected for issue fingerprinting.",
});
const batchFull = meter.createCounter("superlog.worker.telemetry.batch_full", {
  description:
    "Telemetry ingest batches that selected BATCH_SIZE timestamp groups, indicating backlog pressure.",
});
const batchDurationMs = meter.createHistogram("superlog.worker.telemetry.batch_duration_ms", {
  description: "Wall-clock duration of a telemetry ingest batch.",
  unit: "ms",
});
const rowFailures = meter.createCounter("superlog.worker.telemetry.row_failures", {
  description:
    "Telemetry rows whose issue upsert threw and were skipped so the batch could make progress.",
});
const pendingRowsGauge = meter.createObservableGauge("superlog.worker.telemetry.pending_rows", {
  description: "Rows currently matching telemetry ingest filters after the durable cursor.",
});
const oldestPendingAgeMsGauge = meter.createObservableGauge(
  "superlog.worker.telemetry.oldest_pending_age_ms",
  {
    description: "Age of the oldest telemetry row waiting behind the ingest cursor.",
    unit: "ms",
  },
);
const cursorLagMsGauge = meter.createObservableGauge("superlog.worker.telemetry.cursor_lag_ms", {
  description: "Time between the durable cursor and the newest pending telemetry row.",
  unit: "ms",
});

type ClickHouseClientLike = {
  query(input: {
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
  }): Promise<{ json(): Promise<unknown> }>;
};

type CHSpanRow = {
  ts: string;
  project_id: string;
  service: string;
  span_name: string;
  trace_id: string;
  span_id: string;
  exc_type: string;
  exc_message: string;
  exc_stack: string;
  span_attrs: Record<string, string>;
  resource_attrs: Record<string, string>;
};

type CHLogRow = {
  ts: string;
  project_id: string;
  service: string;
  severity: string;
  severity_number: number;
  body: string;
  trace_id: string;
  span_id: string;
  log_attrs: Record<string, string>;
  resource_attrs: Record<string, string>;
  exc_type: string;
  exc_stack: string;
};

type BacklogStatsRow = {
  pending_rows: number | string;
  oldest_pending_ts: string | null;
  latest_pending_ts: string | null;
};

// Transition of a fingerprint occurrence, decided by the existing issue's
// lifecycle status (see issue-state.ts):
//   new        — no issue row existed
//   recurred   — the issue was `resolved`; a NEW incident gets opened, chained
//                to the predecessor
//   suppressed — the issue is `silenced` or `under_observation`; counters
//                moved, no incident work
//   seen       — the issue is `open`; nothing to do beyond the counter bump
type Transition = "new" | "recurred" | "suppressed" | "seen";

export type IssueTransitionHandler = (
  issue: schema.Issue,
  transition: "new" | "recurred",
) => Promise<void>;

export type TelemetryIngestor = {
  tickSpans(): Promise<number>;
  tickLogs(): Promise<number>;
};

export function createTelemetryIngestor(opts: {
  clickhouse: ClickHouseClientLike;
  database?: DB;
  batchSize: number;
  discoveryWindowMs?: number;
  now?: Clock;
  handleIssueTransition: IssueTransitionHandler;
}): TelemetryIngestor {
  const database = opts.database ?? defaultDb;
  const discoveryWindowMs = normalizeDiscoveryWindowMs(opts.discoveryWindowMs);
  const now = opts.now ?? (() => new Date());
  return {
    tickSpans: () =>
      tickSpans({
        clickhouse: opts.clickhouse,
        database,
        batchSize: opts.batchSize,
        discoveryWindowMs,
        now,
        handleIssueTransition: opts.handleIssueTransition,
      }),
    tickLogs: () =>
      tickLogs({
        clickhouse: opts.clickhouse,
        database,
        batchSize: opts.batchSize,
        discoveryWindowMs,
        now,
        handleIssueTransition: opts.handleIssueTransition,
      }),
  };
}

// Flat once-a-minute log line per kind so deployment-side log tooling can
// alarm on ingest cursor lag without parsing nested JSON (same convention as
// queue-health.ts).
const CURSOR_LOG_INTERVAL_MS = 60_000;
let cursorLastLoggedAt = 0;

export function registerTelemetryIngestMetrics(opts: {
  clickhouse: ClickHouseClientLike;
  database?: DB;
  discoveryWindowMs?: number;
  now?: Clock;
}): void {
  const database = opts.database ?? defaultDb;
  const discoveryWindowMs = normalizeDiscoveryWindowMs(opts.discoveryWindowMs);
  const now = opts.now ?? (() => new Date());
  meter.addBatchObservableCallback(
    async (result) => {
      const observedAt = Date.now();
      const shouldLog = observedAt - cursorLastLoggedAt >= CURSOR_LOG_INTERVAL_MS;
      if (shouldLog) cursorLastLoggedAt = observedAt;
      for (const kind of ["span", "log"] as const) {
        try {
          const stats = await loadBacklogStats({
            clickhouse: opts.clickhouse,
            database,
            kind,
            discoveryWindowMs,
            now,
          });
          const attrs = { "telemetry.kind": kind };
          result.observe(pendingRowsGauge, stats.pendingRows, attrs);
          result.observe(oldestPendingAgeMsGauge, stats.oldestPendingAgeMs, attrs);
          result.observe(cursorLagMsGauge, stats.cursorLagMs, attrs);
          if (shouldLog) {
            logger.info(
              { scope: "queue-health", cursor_kind: kind, cursor_lag_ms: stats.cursorLagMs },
              "ingest cursor lag",
            );
          }
        } catch (err) {
          logger.error(
            { err, scope: "telemetry-ingest-metrics", kind, now: observedAt },
            "telemetry ingest metrics observe failed",
          );
        }
      }
    },
    [pendingRowsGauge, oldestPendingAgeMsGauge, cursorLagMsGauge],
  );
}

// `inserted` (xmax = 0 on the RETURNING row) means the upsert genuinely
// created a new issue row — that is always a "new" transition, even if a
// stale `prev` row was visible (pre-0082 schema, where the partial unique
// index lets a silenced fingerprint spawn a fresh row; without this check
// that new row would be classified "suppressed" and never get an incident).
function computeTransition(
  prevIssueId: string | null,
  prevIssueStatus: string | null,
  inserted: boolean,
): Transition {
  if (inserted || prevIssueId === null) return "new";
  if (prevIssueStatus === "silenced" || prevIssueStatus === "under_observation") {
    return "suppressed";
  }
  if (prevIssueStatus === "resolved") return "recurred";
  return "seen";
}

function dateToChString(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, -1);
}

function chStringToDate(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

async function existingProjectIds(database: DB, projectIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(projectIds.filter((id) => UUID_RE.test(id)))];
  if (unique.length === 0) return new Set();
  const rows = await database
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(inArray(schema.projects.id, unique));
  return new Set(rows.map((row) => row.id));
}

// Sanitize attribute keys/values (NUL bytes, lone surrogates) before they are
// JSON-encoded into the `last_sample` jsonb column — Postgres jsonb rejects
// both just like text.
function sanitizeAttrs(
  attrs: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!attrs) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[sanitizeForPg(k)] = sanitizeForPg(v);
  return out;
}

function buildIssueTitle(fp: Fingerprint, message: string | null): string {
  if (fp.topFrame) return `${fp.exceptionType}: ${fp.topFrame}`;
  if (message) return `${fp.exceptionType}: ${message.slice(0, 120)}`;
  return fp.exceptionType;
}

async function getCursor(database: DB, name: string): Promise<string> {
  const row = await database.query.workerState.findFirst({
    where: (workerState, { eq }) => eq(workerState.name, name),
  });
  return row ? dateToChString(row.cursor) : ZERO_CURSOR;
}

async function setCursor(database: DB, name: string, cursorCh: string) {
  const d = chStringToDate(cursorCh);
  await database
    .insert(schema.workerState)
    .values({ name, cursor: d, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.workerState.name,
      set: { cursor: d, updatedAt: new Date() },
    });
}

function normalizeDiscoveryWindowMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DISCOVERY_WINDOW_MS;
  }
  return Math.max(1, Math.floor(value));
}

function attrClauseMatches(
  clause: schema.IssueFilterClause,
  attrsList: Array<Record<string, string> | null | undefined>,
): boolean {
  const wantedKey = clause.key.toLowerCase();
  for (const attrs of attrsList) {
    if (!attrs) continue;
    for (const [k, v] of Object.entries(attrs)) {
      if (k.toLowerCase() === wantedKey && v === clause.value) return true;
    }
  }
  return false;
}

function eventPassesIssueFilter(
  kind: "span" | "log",
  config: schema.IssueFilterConfig,
  attrsList: Array<Record<string, string> | null | undefined>,
): boolean {
  const excludes = kind === "log" ? config.excludeLogs : config.excludeSpans;
  for (const clause of excludes) {
    if (attrClauseMatches(clause, attrsList)) return false;
  }
  const includes = kind === "log" ? config.includeLogs : config.includeSpans;
  if (includes.length === 0) return true;
  return includes.some((clause) => attrClauseMatches(clause, attrsList));
}

async function loadIssueFiltersForProjects(
  database: DB,
  projectIds: string[],
): Promise<Map<string, schema.IssueFilterConfig>> {
  const unique = [...new Set(projectIds.filter((id) => UUID_RE.test(id)))];
  if (unique.length === 0) return new Map();
  const out = new Map<string, schema.IssueFilterConfig>();
  const rows = await database.query.projectAutomationSettings.findMany({
    where: inArray(schema.projectAutomationSettings.projectId, unique),
    columns: { projectId: true, issueFilterConfig: true },
  });
  for (const id of unique) out.set(id, schema.EMPTY_ISSUE_FILTER_CONFIG);
  for (const row of rows) {
    out.set(row.projectId, row.issueFilterConfig ?? schema.EMPTY_ISSUE_FILTER_CONFIG);
  }
  return out;
}

type PendingIssue = {
  projectId: string;
  kind: "span" | "log";
  service: string | null;
  fp: Fingerprint;
  message: string | null;
  firstSeen: Date;
  lastSeen: Date;
  lastSample: IssueSample;
  eventCount: number;
};

// Collapse rows that share a (project, fingerprint) into one pending upsert.
// A single exception storm emits thousands of rows that all map to one issue,
// so instead of one Postgres round-trip per row we accumulate the count in
// memory and issue one upsert per distinct fingerprint per batch. We keep the
// newest row's sample (and its message/service) and the min/max seen times.
function accumulateIssue(groups: Map<string, PendingIssue>, candidate: PendingIssue): void {
  const key = `${candidate.projectId}::${candidate.fp.hash}`;
  const existing = groups.get(key);
  if (!existing) {
    groups.set(key, candidate);
    return;
  }
  existing.eventCount += candidate.eventCount;
  if (candidate.firstSeen < existing.firstSeen) existing.firstSeen = candidate.firstSeen;
  if (candidate.lastSeen >= existing.lastSeen) {
    existing.lastSeen = candidate.lastSeen;
    existing.lastSample = candidate.lastSample;
    existing.message = candidate.message ?? existing.message;
    existing.service = candidate.service ?? existing.service;
  }
}

// Upsert every accumulated group, isolating each one so a single failing group
// (e.g. a value Postgres rejects) is logged + counted and skipped rather than
// wedging the cursor for the whole batch.
async function flushIssueGroups(
  database: DB,
  groups: Map<string, PendingIssue>,
  handleIssueTransition: IssueTransitionHandler,
): Promise<void> {
  for (const group of groups.values()) {
    try {
      const up = await upsertIssue(database, group);
      if ((up.transition === "new" || up.transition === "recurred") && up.issue) {
        logger.info(
          {
            kind: group.kind,
            transition: up.transition,
            projectId: group.projectId,
            fingerprint: group.fp.hash,
            exceptionType: group.fp.exceptionType,
            events: group.eventCount,
          },
          "issue transition",
        );
        await handleIssueTransition(up.issue, up.transition);
      }
    } catch (err) {
      rowFailures.add(group.eventCount, { "telemetry.kind": group.kind });
      logger.error(
        {
          err,
          kind: group.kind,
          projectId: group.projectId,
          fingerprint: group.fp.hash,
          events: group.eventCount,
        },
        "issue upsert failed; skipping rows",
      );
    }
  }
}

async function upsertIssue(
  database: DB,
  group: PendingIssue,
): Promise<{ transition: Transition; issue: schema.Issue | null }> {
  return tracer.startActiveSpan("issue.fingerprint", async (span) => {
    span.setAttribute("issue.kind", group.kind);
    span.setAttribute("issue.fingerprint", group.fp.hash);
    span.setAttribute("issue.exception_type", group.fp.exceptionType);
    if (group.service) span.setAttribute("issue.service", group.service);
    span.setAttribute("issue.project_id", group.projectId);
    span.setAttribute("issue.event_count", group.eventCount);
    try {
      const title = buildIssueTitle(group.fp, group.message);
      const firstSeenIso = group.firstSeen.toISOString();
      const lastSeenIso = group.lastSeen.toISOString();
      const normalizedFrames = JSON.stringify(group.fp.normalizedFrames);
      const lastSample = JSON.stringify(group.lastSample);
      const result = await database.execute<{
        id: string;
        xmax: string;
        prev_issue_id: string | null;
        prev_issue_status: string | null;
      }>(sql`
    WITH prev AS (
      SELECT i.id AS issue_id, i.status AS issue_status
      FROM issues i
      WHERE i.project_id = ${group.projectId}
        AND i.fingerprint = ${group.fp.hash}
      ORDER BY (i.silenced_at IS NULL) DESC, i.last_seen DESC
      LIMIT 1
    ),
    up AS (
      INSERT INTO issues (
        project_id, fingerprint, kind, service, exception_type,
        title, message, top_frame, normalized_frames, last_sample,
        first_seen, last_seen, event_count
      ) VALUES (
        ${group.projectId}, ${group.fp.hash}, ${group.kind}, ${group.service}, ${group.fp.exceptionType},
        ${title}, ${group.message}, ${group.fp.topFrame}, ${normalizedFrames}::jsonb, ${lastSample}::jsonb,
        ${firstSeenIso}::timestamptz, ${lastSeenIso}::timestamptz, ${group.eventCount}
      )
      -- The WHERE clause is arbiter-index *inference*, not conflict filtering:
      -- it matches the legacy partial unique index (pre-0082 schema) and is
      -- trivially implied by the full unique index that replaces it, so this
      -- one statement works on both sides of the migration window. Post-0082
      -- every duplicate fingerprint conflicts, silenced or not.
      ON CONFLICT (project_id, fingerprint) WHERE silenced_at IS NULL DO UPDATE SET
        last_seen = GREATEST(issues.last_seen, EXCLUDED.last_seen),
        first_seen = LEAST(issues.first_seen, EXCLUDED.first_seen),
        event_count = issues.event_count + ${group.eventCount},
        message = COALESCE(EXCLUDED.message, issues.message),
        service = COALESCE(EXCLUDED.service, issues.service),
        top_frame = COALESCE(EXCLUDED.top_frame, issues.top_frame),
        normalized_frames = EXCLUDED.normalized_frames,
        last_sample = EXCLUDED.last_sample
      RETURNING id, xmax
    )
    SELECT
      (SELECT id::text FROM up) AS id,
      (SELECT xmax::text FROM up) AS xmax,
      (SELECT issue_id::text FROM prev) AS prev_issue_id,
      (SELECT issue_status FROM prev) AS prev_issue_status
  `);
      const raw = (
        result as unknown as Array<{
          id: string;
          xmax: string;
          prev_issue_id: string | null;
          prev_issue_status: string | null;
        }>
      )[0];
      const transition = computeTransition(
        raw?.prev_issue_id ?? null,
        raw?.prev_issue_status ?? null,
        raw?.xmax === "0",
      );
      span.setAttribute("issue.transition", transition);
      // Only reload the full row when a downstream handler needs it (new or
      // recurred). The "seen" and "suppressed" paths skip the second query —
      // suppressed occurrences bump counters on the row and deliberately do
      // nothing else.
      let issue: schema.Issue | null = null;
      if (transition === "new" || transition === "recurred") {
        issue =
          (await database.query.issues.findFirst({
            where: (issues, { eq }) => eq(issues.id, raw?.id ?? ""),
          })) ?? null;
        if (!issue) throw new Error("failed to load issue after upsert");
      }
      return { transition, issue };
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

function boundedCursorParams(
  cursor: string,
  discoveryWindowMs: number,
  now: Clock,
): { cursorTs: string; untilTs: string } {
  const cursorMs = chStringToDate(cursor).getTime();
  const untilMs = Math.max(cursorMs, Math.min(cursorMs + discoveryWindowMs, now().getTime()));
  return {
    cursorTs: cursor,
    untilTs: dateToChString(new Date(untilMs)),
  };
}

function recordBatchMetrics(input: {
  kind: TelemetryKind;
  rows: number;
  batchLimited: boolean;
  durationMs: number;
}): void {
  const attrs = { "telemetry.kind": input.kind };
  batchRows.add(input.rows, attrs);
  if (input.batchLimited) batchFull.add(1, attrs);
  batchDurationMs.record(input.durationMs, attrs);
}

function distinctTimestampCount(rows: Array<{ ts: string }>): number {
  return new Set(rows.map((row) => row.ts)).size;
}

function parseChTimestampMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = chStringToDate(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

async function loadBacklogStats(opts: {
  clickhouse: ClickHouseClientLike;
  database: DB;
  kind: TelemetryKind;
  discoveryWindowMs: number;
  now: Clock;
}): Promise<{ pendingRows: number; oldestPendingAgeMs: number; cursorLagMs: number }> {
  const cursorName = opts.kind === "span" ? SPAN_CURSOR : LOG_CURSOR;
  const cursor = await getCursor(opts.database, cursorName);
  const cursorWindow = boundedCursorParams(cursor, opts.discoveryWindowMs, opts.now);
  const result = await opts.clickhouse.query({
    query: opts.kind === "span" ? spanBacklogStatsQuery() : logBacklogStatsQuery(),
    query_params: cursorWindow,
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as BacklogStatsRow[];
  const row = rows[0];
  const pendingRows = Number(row?.pending_rows ?? 0);
  if (!row || pendingRows <= 0) {
    return { pendingRows: 0, oldestPendingAgeMs: 0, cursorLagMs: 0 };
  }
  const oldestMs = parseChTimestampMs(row.oldest_pending_ts);
  const latestMs = parseChTimestampMs(row.latest_pending_ts);
  const cursorMs = parseChTimestampMs(cursor);
  return {
    pendingRows,
    oldestPendingAgeMs: oldestMs === null ? 0 : Math.max(0, Date.now() - oldestMs),
    cursorLagMs: latestMs === null || cursorMs === null ? 0 : Math.max(0, latestMs - cursorMs),
  };
}

// Backlog stats + the tick fetches below read otel_exceptions (the
// exception-only projection, see migrations/004_otel_exceptions.sql) instead of
// ARRAY JOIN-scanning otel_traces / full-scanning otel_logs. Membership in
// otel_exceptions already mirrors the old predicates (span `exception` events;
// logs SeverityNumber>=17), so the `kind` filter is the only scope needed.
function spanBacklogStatsQuery(): string {
  return `
    SELECT
      count() AS pending_rows,
      toString(min(Timestamp)) AS oldest_pending_ts,
      toString(max(Timestamp)) AS latest_pending_ts
    FROM otel_exceptions
    WHERE kind = 'span'
      AND Timestamp > parseDateTime64BestEffort({cursorTs:String}, 6)
      AND Timestamp <= parseDateTime64BestEffort({untilTs:String}, 6)
      AND project_id != ''
  `;
}

function logBacklogStatsQuery(): string {
  return `
    SELECT
      count() AS pending_rows,
      toString(min(Timestamp)) AS oldest_pending_ts,
      toString(max(Timestamp)) AS latest_pending_ts
    FROM otel_exceptions
    WHERE kind = 'log'
      AND Timestamp > parseDateTime64BestEffort({cursorTs:String}, 6)
      AND Timestamp <= parseDateTime64BestEffort({untilTs:String}, 6)
      AND project_id != ''
  `;
}

async function tickSpans(opts: {
  clickhouse: ClickHouseClientLike;
  database: DB;
  batchSize: number;
  discoveryWindowMs: number;
  now: Clock;
  handleIssueTransition: IssueTransitionHandler;
}): Promise<number> {
  return tracer.startActiveSpan("events.batch_insert", async (span) => {
    span.setAttribute("events.kind", "span");
    const startedAt = performance.now();
    let rowsProcessed = 0;
    let selectedTimestampCount = 0;
    try {
      const cursor = await getCursor(opts.database, SPAN_CURSOR);
      const cursorWindow = boundedCursorParams(cursor, opts.discoveryWindowMs, opts.now);
      const result = await opts.clickhouse.query({
        query: `
      WITH selected_timestamps AS (
        SELECT Timestamp
        FROM otel_exceptions
        WHERE kind = 'span'
          AND Timestamp > parseDateTime64BestEffort({cursorTs:String}, 6)
          AND Timestamp <= parseDateTime64BestEffort({untilTs:String}, 6)
          AND project_id != ''
        GROUP BY Timestamp
        ORDER BY Timestamp ASC
        LIMIT {limit:UInt32}
      )
      SELECT
        toString(Timestamp) AS ts,
        project_id,
        service,
        span_name,
        trace_id,
        span_id,
        attrs AS span_attrs,
        resource_attrs,
        exception_type AS exc_type,
        exception_message AS exc_message,
        exception_stacktrace AS exc_stack
      FROM otel_exceptions
      WHERE kind = 'span'
        AND project_id != ''
        AND Timestamp IN (SELECT Timestamp FROM selected_timestamps)
      ORDER BY Timestamp ASC, project_id ASC, service ASC, trace_id ASC, span_id ASC, exc_type ASC, exc_message ASC, exc_stack ASC
    `,
        query_params: { ...cursorWindow, limit: opts.batchSize },
        format: "JSONEachRow",
      });

      const rows = (await result.json()) as CHSpanRow[];
      rowsProcessed = rows.length;
      selectedTimestampCount = distinctTimestampCount(rows);
      span.setAttribute("events.rows", rows.length);
      if (rows.length === 0) {
        await setCursor(opts.database, SPAN_CURSOR, cursorWindow.untilTs);
        return 0;
      }

      let nextCursor = cursor;
      const validProjectIds = await existingProjectIds(
        opts.database,
        rows.map((row) => row.project_id),
      );
      const issueFilters = await loadIssueFiltersForProjects(
        opts.database,
        rows.map((row) => row.project_id),
      );
      const groups = new Map<string, PendingIssue>();
      let skippedUnknownProjects = 0;
      let skippedByFilter = 0;
      for (const row of rows) {
        // Advance past every selected row up front (even skipped/failed ones) so
        // the batch can never wedge the cursor; the upserts happen afterward.
        nextCursor = row.ts;
        if (!validProjectIds.has(row.project_id)) {
          skippedUnknownProjects += 1;
          continue;
        }
        const filter = issueFilters.get(row.project_id) ?? schema.EMPTY_ISSUE_FILTER_CONFIG;
        if (!eventPassesIssueFilter("span", filter, [row.resource_attrs, row.span_attrs])) {
          skippedByFilter += 1;
          continue;
        }
        const excMessage = sanitizeForPg(row.exc_message) || null;
        const excStack = sanitizeForPg(row.exc_stack) || null;
        const service = sanitizeForPg(row.service) || null;
        const fp = fingerprint({
          type: row.exc_type,
          stacktrace: excStack,
          message: excMessage,
        });
        const seenAt = chStringToDate(row.ts);
        const lastSample: IssueSample = {
          kind: "span",
          service,
          severity: null,
          message: excMessage,
          body: null,
          exceptionType: fp.exceptionType,
          topFrame: fp.topFrame,
          normalizedFrames: fp.normalizedFrames,
          stacktrace: excStack,
          seenAt: seenAt.toISOString(),
          traceId: row.trace_id || null,
          spanId: row.span_id || null,
          spanName: sanitizeForPg(row.span_name) || null,
          spanAttrs: sanitizeAttrs(row.span_attrs),
          resourceAttrs: sanitizeAttrs(row.resource_attrs),
        };
        accumulateIssue(groups, {
          projectId: row.project_id,
          kind: "span",
          service,
          fp,
          message: excMessage,
          firstSeen: seenAt,
          lastSeen: seenAt,
          lastSample,
          eventCount: 1,
        });
      }
      await flushIssueGroups(opts.database, groups, opts.handleIssueTransition);
      logSkippedEvents("span", skippedUnknownProjects, skippedByFilter);
      if (selectedTimestampCount < opts.batchSize) nextCursor = cursorWindow.untilTs;
      await setCursor(opts.database, SPAN_CURSOR, nextCursor);
      return rows.length;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      recordBatchMetrics({
        kind: "span",
        rows: rowsProcessed,
        batchLimited: selectedTimestampCount >= opts.batchSize,
        durationMs: performance.now() - startedAt,
      });
      span.end();
    }
  });
}

async function tickLogs(opts: {
  clickhouse: ClickHouseClientLike;
  database: DB;
  batchSize: number;
  discoveryWindowMs: number;
  now: Clock;
  handleIssueTransition: IssueTransitionHandler;
}): Promise<number> {
  return tracer.startActiveSpan("events.batch_insert", async (span) => {
    span.setAttribute("events.kind", "log");
    const startedAt = performance.now();
    let rowsProcessed = 0;
    let selectedTimestampCount = 0;
    try {
      const cursor = await getCursor(opts.database, LOG_CURSOR);
      const cursorWindow = boundedCursorParams(cursor, opts.discoveryWindowMs, opts.now);
      const result = await opts.clickhouse.query({
        query: `
      WITH selected_timestamps AS (
        SELECT Timestamp
        FROM otel_exceptions
        WHERE kind = 'log'
          AND Timestamp > parseDateTime64BestEffort({cursorTs:String}, 6)
          AND Timestamp <= parseDateTime64BestEffort({untilTs:String}, 6)
          AND project_id != ''
        GROUP BY Timestamp
        ORDER BY Timestamp ASC
        LIMIT {limit:UInt32}
      )
      SELECT
        toString(Timestamp) AS ts,
        project_id,
        service,
        severity,
        severity_number,
        body,
        trace_id,
        span_id,
        attrs AS log_attrs,
        resource_attrs,
        exception_type AS exc_type,
        exception_stacktrace AS exc_stack
      FROM otel_exceptions
      WHERE kind = 'log'
        AND project_id != ''
        AND Timestamp IN (SELECT Timestamp FROM selected_timestamps)
      ORDER BY Timestamp ASC, project_id ASC, service ASC, trace_id ASC, span_id ASC, leftPad(toString(severity_number), 3, '0') ASC, severity ASC, body ASC, exc_type ASC, exc_stack ASC
    `,
        query_params: { ...cursorWindow, limit: opts.batchSize },
        format: "JSONEachRow",
      });

      const rows = (await result.json()) as CHLogRow[];
      rowsProcessed = rows.length;
      selectedTimestampCount = distinctTimestampCount(rows);
      span.setAttribute("events.rows", rows.length);
      if (rows.length === 0) {
        await setCursor(opts.database, LOG_CURSOR, cursorWindow.untilTs);
        return 0;
      }

      let nextCursor = cursor;
      const validProjectIds = await existingProjectIds(
        opts.database,
        rows.map((row) => row.project_id),
      );
      const issueFilters = await loadIssueFiltersForProjects(
        opts.database,
        rows.map((row) => row.project_id),
      );
      const groups = new Map<string, PendingIssue>();
      let skippedUnknownProjects = 0;
      let skippedByFilter = 0;
      for (const row of rows) {
        // Advance past every selected row up front (even skipped/failed ones) so
        // the batch can never wedge the cursor; the upserts happen afterward.
        nextCursor = row.ts;
        if (!validProjectIds.has(row.project_id)) {
          skippedUnknownProjects += 1;
          continue;
        }
        const filter = issueFilters.get(row.project_id) ?? schema.EMPTY_ISSUE_FILTER_CONFIG;
        if (!eventPassesIssueFilter("log", filter, [row.resource_attrs, row.log_attrs])) {
          skippedByFilter += 1;
          continue;
        }
        const body = sanitizeForPg(row.body) || null;
        const excStack = sanitizeForPg(row.exc_stack) || null;
        const service = sanitizeForPg(row.service) || null;
        const fp = fingerprintLog({
          service: row.service,
          severity: row.severity,
          body: row.body,
          exceptionType: row.exc_type || null,
          stacktrace: excStack,
        });
        const seenAt = chStringToDate(row.ts);
        const lastSample: IssueSample = {
          kind: "log",
          service,
          severity: sanitizeForPg(row.severity) || null,
          message: body,
          body,
          exceptionType: fp.exceptionType,
          topFrame: fp.topFrame,
          normalizedFrames: fp.normalizedFrames,
          stacktrace: excStack,
          seenAt: seenAt.toISOString(),
          traceId: row.trace_id || null,
          spanId: row.span_id || null,
          severityNumber: row.severity_number ?? null,
          logAttrs: sanitizeAttrs(row.log_attrs),
          resourceAttrs: sanitizeAttrs(row.resource_attrs),
        };
        accumulateIssue(groups, {
          projectId: row.project_id,
          kind: "log",
          service,
          fp,
          message: body,
          firstSeen: seenAt,
          lastSeen: seenAt,
          lastSample,
          eventCount: 1,
        });
      }
      await flushIssueGroups(opts.database, groups, opts.handleIssueTransition);
      logSkippedEvents("log", skippedUnknownProjects, skippedByFilter);
      if (selectedTimestampCount < opts.batchSize) nextCursor = cursorWindow.untilTs;
      await setCursor(opts.database, LOG_CURSOR, nextCursor);
      return rows.length;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      recordBatchMetrics({
        kind: "log",
        rows: rowsProcessed,
        batchLimited: selectedTimestampCount >= opts.batchSize,
        durationMs: performance.now() - startedAt,
      });
      span.end();
    }
  });
}

function logSkippedEvents(kind: "span" | "log", unknownProjects: number, byFilter: number): void {
  if (unknownProjects > 0) {
    logger.warn({ kind, skipped: unknownProjects }, "skipped events for unknown projects");
  }
  if (byFilter > 0) {
    logger.info({ kind, skipped: byFilter }, "skipped events not matching project issue filter");
  }
}
