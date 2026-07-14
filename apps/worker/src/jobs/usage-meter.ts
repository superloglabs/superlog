// Billing scans can be much slower than interactive ClickHouse reads when a
// metric partition is busy. Run them on an exclusive pg-boss queue with their
// own client deadline so they cannot extend or block the core worker tick.
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { type UsageMeterTicker, createUsageMeterTicker } from "../billing/usage-meter-ticker.js";
import type { JobDefinition } from "../jobs.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_EXECUTION_TIME_SECONDS = 25;

type UsageClickHouseClient = Pick<ClickHouseClient, "query" | "close">;
type ClientConfig = NonNullable<Parameters<typeof createClient>[0]>;
type MeterOptions = Parameters<typeof createUsageMeterTicker>[0];

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createUsageMeterJob(
  options: {
    env?: Record<string, string | undefined>;
    createClient?: (config: ClientConfig) => UsageClickHouseClient;
    createMeter?: (options: MeterOptions) => UsageMeterTicker | null;
  } = {},
): JobDefinition {
  const env = options.env ?? process.env;
  const secretKey = env.AUTUMN_SECRET_KEY?.trim();
  const createClickHouse = options.createClient ?? ((config: ClientConfig) => createClient(config));
  const createMeter = options.createMeter ?? createUsageMeterTicker;

  return {
    name: "usage-meter",
    schedule: "* * * * *",
    expireInSeconds: 1_800,
    create: ({ db }) => {
      if (!secretKey) return null;
      return async () => {
        const clickhouse = createClickHouse({
          url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
          username: env.CLICKHOUSE_USER ?? "default",
          password: env.CLICKHOUSE_PASSWORD ?? "",
          database: env.CLICKHOUSE_DB ?? "superlog",
          request_timeout: positiveNumber(
            env.BILLING_CLICKHOUSE_REQUEST_TIMEOUT_MS,
            DEFAULT_REQUEST_TIMEOUT_MS,
          ),
          // Stop work on the server before the HTTP client gives up. Without
          // this, an expired client socket can leave ClickHouse scanning until
          // it tries to write the response and hits a broken pipe.
          clickhouse_settings: {
            max_execution_time: positiveNumber(
              env.BILLING_CLICKHOUSE_MAX_EXECUTION_TIME_SECONDS,
              DEFAULT_MAX_EXECUTION_TIME_SECONDS,
            ),
          },
        });
        try {
          // pg-boss owns the minute cadence and exclusive execution; disable
          // the old process-local interval gate for this one-shot handler.
          const meter = createMeter({ db, clickhouse, secretKey, intervalMs: 0 });
          await meter?.();
        } finally {
          await clickhouse.close();
        }
      };
    },
  };
}

export const job = createUsageMeterJob();
