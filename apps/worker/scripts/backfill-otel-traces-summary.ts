import "../src/env.js";
import { createClient } from "@clickhouse/client";

// Backfill historical rows into the trace-list fast-path tables (see
// infra/clickhouse/migrations/005_otel_traces_summary.sql):
//   - superlog.otel_traces_recent  (time-ordered span index; one row per span)
//   - superlog.otel_traces_summary (aggregate state; one row per trace)
// The materialized views only capture spans ingested AFTER they are created, so
// traces already in otel_traces need this one-time pass to appear in the list.
//
// Each SELECT is identical to the matching MV, with an added [from, to)
// Timestamp window — so backfilled rows are byte-for-byte what the MVs produce.
//
// DOUBLE COUNTING: run the backfill ONCE, strictly up to the moment the MVs went
// live. otel_traces_summary is an AggregatingMergeTree keyed (project_id,
// TraceId): re-inserting a span (by overlapping the live MV window or rerunning a
// range) inflates span_count/error_count. otel_traces_recent is a plain
// MergeTree: re-inserting duplicates rows (harmless to ranking but wasteful).
// Give it:
//   --from <retention start>  --to <migration-apply time>
// so the backfill owns [retention_start, mv_cutover) and the MVs own
// [mv_cutover, now). A trace straddling the cutover is fine: early spans from the
// backfill, late spans from the MV, states merge to the correct union.
//
// Dry run by default; pass --apply to write. Example:
//   pnpm --filter @superlog/worker exec tsx scripts/backfill-otel-traces-summary.ts \
//     --from 2026-06-02 --to 2026-07-02T16:00:00Z --chunk-hours 6 --apply

type Args = {
  from: Date;
  to: Date;
  chunkHours: number;
  projectId?: string;
  apply: boolean;
};

const args = parseArgs(process.argv.slice(2));
const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_DB ?? "superlog",
});

const windowFilter = `
      AND ResourceAttributes['superlog.project_id'] != ''
      AND TraceId != ''
      AND Timestamp >= parseDateTime64BestEffort({from:String}, 9)
      AND Timestamp < parseDateTime64BestEffort({to:String}, 9)`;

// otel_traces_recent_mv: one row per span, no aggregation.
function recentInsert(projectFilter: string): string {
  return `
    INSERT INTO otel_traces_recent
    SELECT
      ResourceAttributes['superlog.project_id'] AS project_id,
      Timestamp AS ts,
      TraceId AS trace_id
    FROM otel_traces
    WHERE 1 ${windowFilter} ${projectFilter}
  `;
}

// otel_traces_summary_mv: one aggregate-state row per (project_id, TraceId).
function summaryInsert(projectFilter: string): string {
  return `
    INSERT INTO otel_traces_summary
    SELECT
      ResourceAttributes['superlog.project_id'] AS project_id,
      TraceId AS trace_id,
      min(Timestamp) AS start,
      min(toUnixTimestamp64Nano(Timestamp)) AS start_unix_nano,
      max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS end_unix_nano,
      count() AS span_count,
      countIf(StatusCode = 'STATUS_CODE_ERROR') AS error_count,
      argMinState(SpanName, Timestamp) AS root_span_name,
      argMinState(ServiceName, Timestamp) AS root_service,
      argMinState(StatusCode, Timestamp) AS root_status_code,
      uniqExactState(ServiceName) AS services
    FROM otel_traces
    WHERE 1 ${windowFilter} ${projectFilter}
    GROUP BY project_id, trace_id
  `;
}

// Spans (recent rows) and distinct traces (summary rows) in the window.
async function countWindow(
  projectFilter: string,
  params: Record<string, unknown>,
): Promise<{ spanRows: number; traceRows: number }> {
  const res = await clickhouse.query({
    query: `
      SELECT count() AS spanRows, uniqExact(TraceId) AS traceRows
      FROM otel_traces
      WHERE 1 ${windowFilter} ${projectFilter}
    `,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { spanRows: string | number; traceRows: string | number }[];
  return { spanRows: Number(rows[0]?.spanRows ?? 0), traceRows: Number(rows[0]?.traceRows ?? 0) };
}

let insertedSpanRows = 0;
let insertedTraceRows = 0;

try {
  console.log(
    JSON.stringify({
      apply: args.apply,
      from: args.from.toISOString(),
      to: args.to.toISOString(),
      chunkHours: args.chunkHours,
      projectId: args.projectId ?? null,
      note: args.apply
        ? "INSERTs merge into aggregate states / append to the index; do not overlap the live MV window or rerun a range."
        : "dry run only; pass --apply to insert rows",
    }),
  );

  const projectFilter = args.projectId
    ? "AND ResourceAttributes['superlog.project_id'] = {projectId:String}"
    : "";

  for (const [from, to] of chunkWindows(args.from, args.to, args.chunkHours)) {
    const params: Record<string, unknown> = {
      from: from.toISOString(),
      to: to.toISOString(),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    };

    const { spanRows, traceRows } = await countWindow(projectFilter, params);
    if (args.apply && spanRows > 0) {
      await clickhouse.command({ query: recentInsert(projectFilter), query_params: params });
      await clickhouse.command({ query: summaryInsert(projectFilter), query_params: params });
      insertedSpanRows += spanRows;
      insertedTraceRows += traceRows;
    }

    console.log(
      JSON.stringify({ from: from.toISOString(), to: to.toISOString(), spanRows, traceRows }),
    );
  }

  console.log(JSON.stringify({ insertedSpanRows, insertedTraceRows, applied: args.apply }));
} finally {
  await clickhouse.close();
}

function* chunkWindows(from: Date, to: Date, chunkHours: number): Generator<[Date, Date]> {
  const chunkMs = chunkHours * 60 * 60 * 1000;
  for (let cursor = from.getTime(); cursor < to.getTime(); cursor += chunkMs) {
    yield [new Date(cursor), new Date(Math.min(cursor + chunkMs, to.getTime()))];
  }
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "apply") {
      values.set(key, true);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    values.set(key, value);
    i += 1;
  }

  const to = parseDate(values.get("to")) ?? startOfUtcTomorrow(new Date());
  const from = parseDate(values.get("from")) ?? new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
  const chunkHours = Number(values.get("chunk-hours") ?? 6);
  if (!Number.isFinite(chunkHours) || chunkHours <= 0)
    throw new Error("--chunk-hours must be positive");
  if (from >= to) throw new Error("--from must be before --to");

  return {
    from,
    to,
    chunkHours,
    apply: values.get("apply") === true,
    projectId:
      typeof values.get("project-id") === "string"
        ? (values.get("project-id") as string)
        : undefined,
  };
}

function parseDate(value: string | true | undefined): Date | null {
  if (typeof value !== "string") return null;
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const date = new Date(withTime);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function startOfUtcTomorrow(now: Date): Date {
  const out = new Date(now);
  out.setUTCHours(0, 0, 0, 0);
  out.setUTCDate(out.getUTCDate() + 1);
  return out;
}
