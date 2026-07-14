import "../src/env.js";
import { createClient } from "@clickhouse/client";
import { METRIC_TABLES } from "../src/billing/metric-usage-schema.js";

// Materialize the metric usage projection for existing data after applying
// infra/clickhouse/migrations/008_metric_usage_projection.sql.
//
// The script is dry-run by default and processes one table/date partition at a
// time. With --apply it waits for every replica before moving on, preventing
// five large projection mutations from competing for disk bandwidth.
//
// Example:
//   pnpm --filter @superlog/worker exec tsx scripts/materialize-metric-usage-projections.ts \
//     --from 2026-07-13 --to 2026-07-14 --apply

type Args = { from: string; to: string; apply: boolean };

const args = parseArgs(process.argv.slice(2));
const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_DB ?? "superlog",
  // This is an explicit maintenance command that waits for replicated
  // mutations. The normal worker query deadline remains 30 seconds.
  request_timeout: 6 * 60 * 60 * 1000,
});

type PartitionStatus = {
  parts: number | string;
  totalRows: number | string;
  projectedParts: number | string;
  unprojectedRows: number | string;
  unprojectedBytes: number | string;
};

async function partitionStatus(table: string, partition: string): Promise<PartitionStatus> {
  const result = await clickhouse.query({
    query: `SELECT
              count() AS parts,
              sum(rows) AS totalRows,
              countIf(has(projections, 'usage_by_time')) AS projectedParts,
              sumIf(rows, NOT has(projections, 'usage_by_time')) AS unprojectedRows,
              sumIf(bytes_on_disk, NOT has(projections, 'usage_by_time')) AS unprojectedBytes
            FROM system.parts
            WHERE active
              AND database = currentDatabase()
              AND table = {table:String}
              AND partition = {partition:String}`,
    query_params: { table, partition },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as PartitionStatus[];
  return (
    rows[0] ?? {
      parts: 0,
      totalRows: 0,
      projectedParts: 0,
      unprojectedRows: 0,
      unprojectedBytes: 0,
    }
  );
}

try {
  console.log(JSON.stringify({ ...args, note: args.apply ? "materializing" : "dry run" }));
  for (const partition of datePartitions(args.from, args.to)) {
    for (const table of METRIC_TABLES) {
      const before = await partitionStatus(table, partition);
      const unprojectedRows = Number(before.unprojectedRows);
      console.log(JSON.stringify({ table, partition, phase: "before", ...before }));
      if (!args.apply || !Number.isFinite(unprojectedRows) || unprojectedRows <= 0) continue;

      // Dates are strictly validated by parseArgs before interpolation.
      await clickhouse.command({
        query: `ALTER TABLE ${table}
                MATERIALIZE PROJECTION usage_by_time IN PARTITION '${partition}'
                SETTINGS mutations_sync = 2`,
      });
      const after = await partitionStatus(table, partition);
      console.log(JSON.stringify({ table, partition, phase: "after", ...after }));
    }
  }
} finally {
  await clickhouse.close();
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
    if (key !== "from" && key !== "to") throw new Error(`unknown argument: --${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    values.set(key, value);
    i += 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  const from = stringValue(values.get("from")) ?? today;
  const to = stringValue(values.get("to")) ?? from;
  if (!isIsoDate(from) || !isIsoDate(to)) throw new Error("--from/--to must be YYYY-MM-DD");
  if (from > to) throw new Error("--from must not be after --to");
  return { from, to, apply: values.get("apply") === true };
}

function stringValue(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function* datePartitions(from: string, to: string): Generator<string> {
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}
