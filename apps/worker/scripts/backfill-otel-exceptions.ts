import "../src/env.js";
import { createClient } from "@clickhouse/client";

// Backfill historical rows into superlog.otel_exceptions (see
// infra/clickhouse/migrations/004_otel_exceptions.sql). The materialized views
// only capture rows ingested AFTER they are created, so existing exception
// spans / error logs need this one-time pass.
//
// The SELECTs below are identical to the two MVs, with an added [from, to)
// Timestamp window — so a backfilled row is byte-for-byte what the MV would
// have produced.
//
// DUPLICATES: otel_exceptions is a plain ReplicatedMergeTree (no dedup). Rows
// inserted here AND by the live MV for the same event are double-counted by the
// readers. Run the backfill only up to the moment the MVs went live:
//   --to <migration-apply time>   (and --from <retention start>)
// so the backfill covers [retention_start, mv_cutover) and the MV owns
// [mv_cutover, now). Re-running the same window also duplicates — don't.
//
// Dry run by default; pass --apply to write. Example:
//   pnpm --filter @superlog/worker exec tsx scripts/backfill-otel-exceptions.ts \
//     --from 2026-05-27 --to 2026-06-26T09:00:00Z --chunk-hours 6 --apply

type Args = {
  from: Date;
  to: Date;
  chunkHours: number;
  projectId?: string;
  source: "all" | "traces" | "logs";
  apply: boolean;
};

const args = parseArgs(process.argv.slice(2));
const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_DB ?? "superlog",
});

// Column projections shared by the dry-run count and the INSERT, kept identical
// to otel_exceptions_from_{traces,logs}_mv so backfilled rows match live rows.
function tracesSelectBody(projectFilter: string): string {
  return `
    FROM otel_traces
    ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
    WHERE event_name = 'exception'
      AND ResourceAttributes['superlog.project_id'] != ''
      AND Timestamp >= parseDateTime64BestEffort({from:String}, 9)
      AND Timestamp < parseDateTime64BestEffort({to:String}, 9)
      ${projectFilter}
  `;
}

function logsSelectBody(projectFilter: string): string {
  return `
    FROM otel_logs
    WHERE SeverityNumber >= 17
      AND ResourceAttributes['superlog.project_id'] != ''
      AND Timestamp >= parseDateTime64BestEffort({from:String}, 9)
      AND Timestamp < parseDateTime64BestEffort({to:String}, 9)
      ${projectFilter}
  `;
}

function tracesInsert(projectFilter: string): string {
  return `
    INSERT INTO otel_exceptions
    SELECT
      ResourceAttributes['superlog.project_id'] AS project_id,
      Timestamp,
      'span' AS kind,
      ServiceName AS service,
      SpanName AS span_name,
      TraceId AS trace_id,
      SpanId AS span_id,
      event_attrs['exception.type'] AS exception_type,
      event_attrs['exception.message'] AS exception_message,
      event_attrs['exception.stacktrace'] AS exception_stacktrace,
      event_attrs['superlog.issue_fingerprint'] AS fingerprint,
      if(SpanAttributes['user.id'] != '', SpanAttributes['user.id'], ResourceAttributes['user.id']) AS user_id,
      ResourceAttributes AS resource_attrs,
      SpanAttributes AS attrs,
      '' AS body,
      '' AS severity,
      toUInt8(0) AS severity_number
    ${tracesSelectBody(projectFilter)}
  `;
}

function logsInsert(projectFilter: string): string {
  return `
    INSERT INTO otel_exceptions
    SELECT
      ResourceAttributes['superlog.project_id'] AS project_id,
      Timestamp,
      'log' AS kind,
      ServiceName AS service,
      '' AS span_name,
      TraceId AS trace_id,
      SpanId AS span_id,
      LogAttributes['exception.type'] AS exception_type,
      LogAttributes['exception.message'] AS exception_message,
      LogAttributes['exception.stacktrace'] AS exception_stacktrace,
      LogAttributes['superlog.issue_fingerprint'] AS fingerprint,
      if(LogAttributes['user.id'] != '', LogAttributes['user.id'], ResourceAttributes['user.id']) AS user_id,
      ResourceAttributes AS resource_attrs,
      LogAttributes AS attrs,
      Body AS body,
      SeverityText AS severity,
      toUInt8(SeverityNumber) AS severity_number
    ${logsSelectBody(projectFilter)}
  `;
}

async function countRows(selectBody: string, params: Record<string, unknown>): Promise<number> {
  const res = await clickhouse.query({
    query: `SELECT count() AS c ${selectBody}`,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { c: string | number }[];
  return Number(rows[0]?.c ?? 0);
}

let insertedSpanRows = 0;
let insertedLogRows = 0;

try {
  console.log(
    JSON.stringify({
      apply: args.apply,
      source: args.source,
      from: args.from.toISOString(),
      to: args.to.toISOString(),
      chunkHours: args.chunkHours,
      projectId: args.projectId ?? null,
      note: args.apply
        ? "INSERTs are additive and not deduplicated; do not overlap the live MV window or rerun a range."
        : "dry run only; pass --apply to insert rows into otel_exceptions",
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

    let spanRows = 0;
    let logRows = 0;

    if (args.source === "all" || args.source === "traces") {
      spanRows = await countRows(tracesSelectBody(projectFilter), params);
      if (args.apply && spanRows > 0) {
        await clickhouse.command({ query: tracesInsert(projectFilter), query_params: params });
        insertedSpanRows += spanRows;
      }
    }
    if (args.source === "all" || args.source === "logs") {
      logRows = await countRows(logsSelectBody(projectFilter), params);
      if (args.apply && logRows > 0) {
        await clickhouse.command({ query: logsInsert(projectFilter), query_params: params });
        insertedLogRows += logRows;
      }
    }

    console.log(
      JSON.stringify({ from: from.toISOString(), to: to.toISOString(), spanRows, logRows }),
    );
  }

  console.log(JSON.stringify({ insertedSpanRows, insertedLogRows, applied: args.apply }));
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
  const source = values.get("source") ?? "all";
  if (source !== "all" && source !== "traces" && source !== "logs") {
    throw new Error("--source must be all, traces, or logs");
  }
  if (!Number.isFinite(chunkHours) || chunkHours <= 0)
    throw new Error("--chunk-hours must be positive");
  if (from >= to) throw new Error("--from must be before --to");

  return {
    from,
    to,
    chunkHours,
    source,
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
