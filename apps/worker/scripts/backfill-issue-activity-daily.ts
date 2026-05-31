import "../src/env.js";
import { createClient } from "@clickhouse/client";
import {
  type IssueActivityAggregate,
  type LogIssueActivityGroup,
  type TraceIssueActivityGroup,
  aggregateLogIssueActivity,
  aggregateTraceIssueActivity,
} from "../src/telemetry/issue-activity-backfill.js";

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

let scannedTraceGroups = 0;
let scannedLogGroups = 0;
let insertedRows = 0;
let insertedEvents = 0;

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
        ? "INSERTs are additive; do not rerun the same range unless you intentionally want duplicate aggregate counts."
        : "dry run only; pass --apply to insert rows into issue_activity_daily",
    }),
  );

  for (const [from, to] of chunkWindows(args.from, args.to, args.chunkHours)) {
    const aggregates = new Map<string, IssueActivityAggregate>();

    if (args.source === "all" || args.source === "traces") {
      const rows = await loadTraceGroups(from, to, args.projectId);
      scannedTraceGroups += rows.length;
      mergeAggregates(aggregates, aggregateTraceIssueActivity(rows));
    }

    if (args.source === "all" || args.source === "logs") {
      const rows = await loadLogGroups(from, to, args.projectId);
      scannedLogGroups += rows.length;
      mergeAggregates(aggregates, aggregateLogIssueActivity(rows));
    }

    const values = [...aggregates.values()].filter((row) => row.event_count > 0);
    const eventCount = values.reduce((sum, row) => sum + row.event_count, 0);
    console.log(
      JSON.stringify({
        from: from.toISOString(),
        to: to.toISOString(),
        aggregateRows: values.length,
        eventCount,
      }),
    );

    if (args.apply && values.length > 0) {
      await clickhouse.insert({
        table: "issue_activity_daily",
        values,
        format: "JSONEachRow",
      });
      insertedRows += values.length;
      insertedEvents += eventCount;
    }
  }

  console.log(
    JSON.stringify({
      scannedTraceGroups,
      scannedLogGroups,
      insertedRows,
      insertedEvents,
      applied: args.apply,
    }),
  );
} finally {
  await clickhouse.close();
}

async function loadTraceGroups(
  from: Date,
  to: Date,
  projectId: string | undefined,
): Promise<TraceIssueActivityGroup[]> {
  const projectFilter = projectId
    ? "AND ResourceAttributes['superlog.project_id'] = {projectId:String}"
    : "";
  const result = await clickhouse.query({
    query: `
      SELECT
        ResourceAttributes['superlog.project_id'] AS project_id,
        toString(toDate(Timestamp)) AS day,
        event_attrs['exception.type'] AS exc_type,
        event_attrs['exception.message'] AS exc_message,
        event_attrs['exception.stacktrace'] AS exc_stack,
        count() AS c
      FROM otel_traces
      ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
      WHERE Timestamp >= parseDateTime64BestEffort({from:String}, 9)
        AND Timestamp < parseDateTime64BestEffort({to:String}, 9)
        AND event_name = 'exception'
        AND ResourceAttributes['superlog.project_id'] != ''
        ${projectFilter}
      GROUP BY project_id, day, exc_type, exc_message, exc_stack
    `,
    query_params: {
      from: from.toISOString(),
      to: to.toISOString(),
      ...(projectId ? { projectId } : {}),
    },
    format: "JSONEachRow",
  });
  return (await result.json()) as TraceIssueActivityGroup[];
}

async function loadLogGroups(
  from: Date,
  to: Date,
  projectId: string | undefined,
): Promise<LogIssueActivityGroup[]> {
  const projectFilter = projectId
    ? "AND ResourceAttributes['superlog.project_id'] = {projectId:String}"
    : "";
  const result = await clickhouse.query({
    query: `
      SELECT
        ResourceAttributes['superlog.project_id'] AS project_id,
        toString(toDate(Timestamp)) AS day,
        ServiceName AS service,
        SeverityText AS severity,
        Body AS body,
        LogAttributes['exception.type'] AS exc_type,
        LogAttributes['exception.stacktrace'] AS exc_stack,
        count() AS c
      FROM otel_logs
      WHERE Timestamp >= parseDateTime64BestEffort({from:String}, 9)
        AND Timestamp < parseDateTime64BestEffort({to:String}, 9)
        AND SeverityNumber >= 17
        AND ResourceAttributes['superlog.project_id'] != ''
        ${projectFilter}
      GROUP BY project_id, day, service, severity, body, exc_type, exc_stack
    `,
    query_params: {
      from: from.toISOString(),
      to: to.toISOString(),
      ...(projectId ? { projectId } : {}),
    },
    format: "JSONEachRow",
  });
  return (await result.json()) as LogIssueActivityGroup[];
}

function mergeAggregates(
  target: Map<string, IssueActivityAggregate>,
  rows: IssueActivityAggregate[],
): void {
  for (const row of rows) {
    const key = `${row.project_id}\u0001${row.fingerprint}\u0001${row.day}`;
    const existing = target.get(key);
    if (existing) {
      existing.event_count += row.event_count;
      continue;
    }
    target.set(key, { ...row });
  }
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
