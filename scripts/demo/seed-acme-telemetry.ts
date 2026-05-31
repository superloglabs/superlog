import process from "node:process";

type Options = {
  target: string;
  ingestUrl: string;
  apiKey: string;
  help: boolean;
};

type ServiceSeed = {
  serviceName: string;
  component: string;
  logs: Array<{
    severityText: "INFO" | "WARN";
    severityNumber: number;
    message: string;
    attributes?: Record<string, string | number>;
  }>;
  metrics: {
    cpuUsage: number;
    memoryUsageBytes: number;
    dbConnections: number;
    requestTotal: number;
  };
};

const SERVICE_SEEDS: ServiceSeed[] = [
  {
    serviceName: "acme-storefront",
    component: "web",
    logs: [
      {
        severityText: "INFO",
        severityNumber: 9,
        message: "acme storefront boot completed",
        attributes: { deployment_slot: "demo", cache_status: "warm" },
      },
      {
        severityText: "WARN",
        severityNumber: 13,
        message: "catalog cache warm took 182ms",
        attributes: { cache_region: "us-west-2", cache_status: "warming" },
      },
    ],
    metrics: {
      cpuUsage: 0.31,
      memoryUsageBytes: 82_944_000,
      dbConnections: 7,
      requestTotal: 1842,
    },
  },
  {
    serviceName: "acme-checkout",
    component: "api",
    logs: [
      {
        severityText: "INFO",
        severityNumber: 9,
        message: "checkout workers synced pricing tables",
        attributes: { sync_target: "pricing", sync_status: "ok" },
      },
      {
        severityText: "WARN",
        severityNumber: 13,
        message: "checkout latency p95 reached 420ms",
        attributes: { latency_bucket: "p95", payment_provider: "stripe" },
      },
    ],
    metrics: {
      cpuUsage: 0.46,
      memoryUsageBytes: 96_128_000,
      dbConnections: 11,
      requestTotal: 974,
    },
  },
  {
    serviceName: "acme-worker",
    component: "worker",
    logs: [
      {
        severityText: "INFO",
        severityNumber: 9,
        message: "fulfillment queue drained scheduled jobs",
        attributes: { queue: "fulfillment", jobs_completed: 24 },
      },
      {
        severityText: "WARN",
        severityNumber: 13,
        message: "fulfillment retry backlog reached 3 jobs",
        attributes: { queue: "fulfillment", backlog_size: 3 },
      },
    ],
    metrics: {
      cpuUsage: 0.22,
      memoryUsageBytes: 63_914_000,
      dbConnections: 4,
      requestTotal: 312,
    },
  },
];

function usage(): string {
  return [
    "Usage:",
    "  pnpm demo:seed:acme -- --ingest-url http://localhost:4000 --api-key sl_public_...",
    "",
    "Options:",
    "  --target <local|prod>           Label the environment in output (default: local)",
    "  --ingest-url <url>              OTLP ingest base URL, e.g. http://localhost:4000",
    "  --api-key <key>                 Ingest API key for the Acme Storefront project",
    "  --help                          Show this message",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const parsed = new Map<string, string>();
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    parsed.set(arg.slice(2), next);
    i += 1;
  }

  return {
    target: parsed.get("target") ?? "local",
    ingestUrl: (parsed.get("ingest-url") ?? "").replace(/\/+$/, ""),
    apiKey: parsed.get("api-key") ?? "",
    help,
  };
}

function stringAttr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function numberAttr(key: string, value: number) {
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } };
}

function toUnixNano(date: Date): string {
  return `${BigInt(date.getTime()) * 1_000_000n}`;
}

function buildResourceAttributes(seed: ServiceSeed, target: string) {
  return [
    stringAttr("service.name", seed.serviceName),
    stringAttr("service.namespace", "acme"),
    stringAttr("service.version", "demo"),
    stringAttr("deployment.environment", "demo"),
    stringAttr("demo.org", "acme"),
    stringAttr("demo.target", target),
    stringAttr("demo.component", seed.component),
  ];
}

function buildLogsPayload(target: string) {
  const now = Date.now();
  return {
    resourceLogs: SERVICE_SEEDS.map((seed, seedIndex) => ({
      resource: {
        attributes: buildResourceAttributes(seed, target),
      },
      scopeLogs: [
        {
          scope: {
            name: "superlog.demo.seed",
            version: "1.0.0",
          },
          logRecords: seed.logs.map((entry, entryIndex) => ({
            timeUnixNano: toUnixNano(new Date(now - (seedIndex * 10 + entryIndex) * 1000)),
            severityNumber: entry.severityNumber,
            severityText: entry.severityText,
            body: {
              stringValue: entry.message,
            },
            attributes: Object.entries(entry.attributes ?? {}).map(([key, value]) =>
              typeof value === "string" ? stringAttr(key, value) : numberAttr(key, value),
            ),
          })),
        },
      ],
    })),
  };
}

// Spread data points across a window so the explorer chart actually has a
// time series to render. We pick a 6-hour window at 30-second granularity →
// 720 points per (service, metric) × 3 services × 4 metrics ≈ 8.6k data
// points. Generous on purpose — agents iterating on chart behaviour want
// enough density to see line / bar shape, group-bys, and aggregations
// without re-seeding for longer ranges.
const SERIES_WINDOW_MINUTES = 6 * 60;
const SERIES_INTERVAL_SECONDS = 30;

// Deterministic per-(service, metric, step) variation so re-seeds produce a
// consistent-looking chart instead of flickering when an agent re-runs
// verify. Cheap hash → [0, 1).
function pseudoRandom(seed: string, step: number): number {
  let h = 2166136261 ^ step;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x100000000;
}

// Smooth gauge value: sinusoid + small jitter centered on `base`. Bounded
// to a fraction of `base` so the line stays readable.
function gaugeValue(serviceName: string, metric: string, base: number, step: number, totalSteps: number): number {
  const phase = (step / totalSteps) * Math.PI * 4;
  const wave = Math.sin(phase + pseudoRandom(`${serviceName}:${metric}:phase`, 0) * Math.PI * 2);
  const jitter = (pseudoRandom(`${serviceName}:${metric}`, step) - 0.5) * 0.15;
  const swing = base * (0.18 * wave + jitter);
  return Math.max(0, base + swing);
}

type Point = { timeUnixNano: string };

function buildGaugePoints(
  startMs: number,
  serviceName: string,
  metric: string,
  base: number,
): (Point & { asDouble: number })[] {
  const points: (Point & { asDouble: number })[] = [];
  const totalSteps = Math.floor((SERIES_WINDOW_MINUTES * 60) / SERIES_INTERVAL_SECONDS);
  for (let step = 0; step <= totalSteps; step += 1) {
    const ts = new Date(startMs + step * SERIES_INTERVAL_SECONDS * 1000);
    points.push({
      timeUnixNano: toUnixNano(ts),
      asDouble: gaugeValue(serviceName, metric, base, step, totalSteps),
    });
  }
  return points;
}

function buildCumulativeSumPoints(
  startMs: number,
  serviceName: string,
  metric: string,
  endTotal: number,
): (Point & { asInt: string; startTimeUnixNano: string })[] {
  // Distribute `endTotal` requests across the window with mild
  // diurnal-style variation, accumulating monotonically.
  const points: (Point & { asInt: string; startTimeUnixNano: string })[] = [];
  const totalSteps = Math.floor((SERIES_WINDOW_MINUTES * 60) / SERIES_INTERVAL_SECONDS);
  const startNano = toUnixNano(new Date(startMs));
  let cumulative = 0;
  const weights: number[] = [];
  let weightSum = 0;
  for (let step = 0; step <= totalSteps; step += 1) {
    const phase = (step / totalSteps) * Math.PI * 2;
    const w = 1 + 0.4 * Math.sin(phase + pseudoRandom(`${serviceName}:${metric}`, 0) * Math.PI);
    weights.push(w);
    weightSum += w;
  }
  for (let step = 0; step <= totalSteps; step += 1) {
    const share = (weights[step] ?? 1) / weightSum;
    cumulative += endTotal * share;
    const ts = new Date(startMs + step * SERIES_INTERVAL_SECONDS * 1000);
    points.push({
      startTimeUnixNano: startNano,
      timeUnixNano: toUnixNano(ts),
      asInt: String(Math.round(cumulative)),
    });
  }
  return points;
}

function buildMetricsPayload(target: string) {
  const now = Date.now();
  const startMs = now - SERIES_WINDOW_MINUTES * 60 * 1000;

  return {
    resourceMetrics: SERVICE_SEEDS.map((seed) => ({
      resource: {
        attributes: buildResourceAttributes(seed, target),
      },
      scopeMetrics: [
        {
          scope: {
            name: "superlog.demo.seed",
            version: "1.0.0",
          },
          metrics: [
            {
              name: "system.cpu.usage",
              unit: "1",
              gauge: {
                dataPoints: buildGaugePoints(
                  startMs,
                  seed.serviceName,
                  "system.cpu.usage",
                  seed.metrics.cpuUsage,
                ),
              },
            },
            {
              name: "system.memory.usage",
              unit: "By",
              gauge: {
                dataPoints: buildGaugePoints(
                  startMs,
                  seed.serviceName,
                  "system.memory.usage",
                  seed.metrics.memoryUsageBytes,
                ),
              },
            },
            {
              name: "db.connections.active",
              unit: "connections",
              gauge: {
                dataPoints: buildGaugePoints(
                  startMs,
                  seed.serviceName,
                  "db.connections.active",
                  seed.metrics.dbConnections,
                ),
              },
            },
            {
              name: "http.requests.total",
              unit: "requests",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: buildCumulativeSumPoints(
                  startMs,
                  seed.serviceName,
                  "http.requests.total",
                  seed.metrics.requestTotal,
                ),
              },
            },
          ],
        },
      ],
    })),
  };
}

async function postJson(url: string, apiKey: string, payload: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) return;

  const body = await response.text();
  throw new Error(`seed request failed (${response.status} ${response.statusText}): ${body}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!options.ingestUrl) throw new Error("--ingest-url is required");
  if (!options.apiKey) throw new Error("--api-key is required");

  await postJson(`${options.ingestUrl}/v1/logs`, options.apiKey, buildLogsPayload(options.target));
  await postJson(
    `${options.ingestUrl}/v1/metrics`,
    options.apiKey,
    buildMetricsPayload(options.target),
  );

  console.log(
    JSON.stringify(
      {
        environment: options.target,
        ingestUrl: options.ingestUrl,
        seededServices: SERVICE_SEEDS.map((seed) => seed.serviceName),
        logRecords: SERVICE_SEEDS.reduce((sum, seed) => sum + seed.logs.length, 0),
        metricDataPoints:
          SERVICE_SEEDS.length *
          4 *
          (Math.floor((SERIES_WINDOW_MINUTES * 60) / SERIES_INTERVAL_SECONDS) + 1),
        seriesWindowMinutes: SERIES_WINDOW_MINUTES,
        seriesIntervalSeconds: SERIES_INTERVAL_SECONDS,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(usage());
  process.exit(1);
});
