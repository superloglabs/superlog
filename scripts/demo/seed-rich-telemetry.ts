// Bypasses the proxy and posts OTLP HTTP directly to the collector with the
// `x-superlog-project-id` header. The collector's `attributes/from_metadata`
// processor promotes that header to a resource attribute, so the API's
// project-scoped reads pick it up the same way they would for a real ingest
// flow.
//
//   pnpm demo:seed:rich -- --project-id <uuid> [--collector-url http://localhost:4318] \
//     [--minutes 60] [--points 30] [--services 4]
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

type Options = {
  projectId: string;
  collectorUrl: string;
  minutes: number;
  points: number;
  services: number;
  help: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  pnpm demo:seed:rich -- --project-id <uuid> [options]",
    "",
    "Options:",
    "  --project-id <uuid>     Target project_id (required)",
    "  --collector-url <url>   OTLP HTTP base (default: http://localhost:4318)",
    "  --minutes <n>           Window to backfill in minutes (default: 60)",
    "  --points <n>            Data points per series (default: 30)",
    "  --services <n>          Distinct services to emit (default: 4)",
    "  --help                  Show this message",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const map = new Map<string, string>();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected: ${arg}`);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${arg}`);
    map.set(arg.slice(2), next);
    i += 1;
  }
  return {
    projectId: map.get("project-id") ?? "",
    collectorUrl: (map.get("collector-url") ?? "http://localhost:4318").replace(/\/+$/, ""),
    minutes: Number(map.get("minutes") ?? 60),
    points: Number(map.get("points") ?? 30),
    services: Math.min(8, Math.max(1, Number(map.get("services") ?? 4))),
    help,
  };
}

const SERVICES = [
  { name: "checkout-api", env: "production", region: "us-east-1" },
  { name: "catalog-api", env: "production", region: "us-east-1" },
  { name: "search-api", env: "production", region: "us-west-2" },
  { name: "fulfillment-worker", env: "production", region: "us-east-1" },
  { name: "auth-api", env: "production", region: "eu-west-1" },
  { name: "billing-worker", env: "production", region: "us-east-1" },
  { name: "notify-worker", env: "production", region: "us-west-2" },
  { name: "edge-proxy", env: "production", region: "global" },
];

const SEVERITIES = [
  { number: 9, text: "INFO", weight: 6 },
  { number: 13, text: "WARN", weight: 2 },
  { number: 17, text: "ERROR", weight: 1 },
];

const LOG_MESSAGES: Record<string, string[]> = {
  INFO: [
    "request handled",
    "cache hit",
    "job complete",
    "session refreshed",
    "feature flag evaluated",
  ],
  WARN: [
    "downstream slow",
    "cache miss",
    "retrying request",
    "queue backlog rising",
  ],
  ERROR: [
    "upstream timeout",
    "db connection refused",
    "auth token rejected",
    "panic recovered",
  ],
};

function stringAttr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}
function intAttr(key: string, value: number) {
  return { key, value: { intValue: String(value) } };
}
function doubleAttr(key: string, value: number) {
  return { key, value: { doubleValue: value } };
}
function nano(date: Date | number): string {
  const ms = typeof date === "number" ? date : date.getTime();
  return `${BigInt(Math.floor(ms)) * 1_000_000n}`;
}

function pickWeighted<T extends { weight: number }>(items: T[], rnd: number): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rnd * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

function buildResourceAttributes(svc: (typeof SERVICES)[number]) {
  return [
    stringAttr("service.name", svc.name),
    stringAttr("service.namespace", "demo"),
    stringAttr("service.version", "1.4.2"),
    stringAttr("deployment.environment", svc.env),
    stringAttr("cloud.region", svc.region),
  ];
}

function buildMetrics(opts: Options, services: typeof SERVICES) {
  const now = Date.now();
  const stepMs = (opts.minutes * 60_000) / opts.points;

  return {
    resourceMetrics: services.map((svc, svcIdx) => {
      const baseRate = 200 + svcIdx * 80;
      const baseLatency = 30 + svcIdx * 5;
      const baseErrors = 1 + svcIdx;

      // Smooth random walk: each point drifts slightly from the previous one
      // (instead of independent jitter) so the resulting line reads as a trend
      // rather than noise.
      const walk = (
        steps: number,
        base: number,
        amplitude: number,
        period: number,
        driftFrac: number,
      ): number[] => {
        const out: number[] = [];
        let drift = 0;
        for (let i = 0; i < steps; i++) {
          const wave = Math.sin((i / steps) * Math.PI * period) * amplitude;
          drift += (Math.random() - 0.5) * base * driftFrac;
          drift *= 0.85; // pull back toward 0 so it doesn't run away
          out.push(Math.max(0, base + wave + drift));
        }
        return out;
      };

      const reqValues = walk(opts.points, baseRate, baseRate * 0.25, 1.5, 0.04);
      const latencyValues = walk(opts.points, baseLatency, baseLatency * 0.15, 1, 0.03);
      const errorValues = walk(opts.points, baseErrors, baseErrors * 0.4, 0.5, 0.05);

      const toPoints = (values: number[]) =>
        values.map((v, i) => ({
          timeUnixNano: nano(now - (opts.points - 1 - i) * stepMs),
          asDouble: v,
        }));

      const reqPoints = toPoints(reqValues);
      const latencyPoints = toPoints(latencyValues);
      const errorPoints = toPoints(errorValues);

      return {
        resource: { attributes: buildResourceAttributes(svc) },
        scopeMetrics: [
          {
            scope: { name: "demo.seed", version: "1.0.0" },
            metrics: [
              {
                name: "http.server.requests",
                unit: "1",
                gauge: { dataPoints: reqPoints },
              },
              {
                name: "http.server.duration",
                unit: "ms",
                gauge: { dataPoints: latencyPoints },
              },
              {
                name: "http.server.errors",
                unit: "1",
                gauge: { dataPoints: errorPoints },
              },
            ],
          },
        ],
      };
    }),
  };
}

function buildLogs(opts: Options, services: typeof SERVICES) {
  const now = Date.now();
  const totalLogs = opts.points * services.length * 4;
  const records: { svcIdx: number; t: number; sev: typeof SEVERITIES[number] }[] = [];
  for (let i = 0; i < totalLogs; i++) {
    records.push({
      svcIdx: Math.floor(Math.random() * services.length),
      t: now - Math.random() * opts.minutes * 60_000,
      sev: pickWeighted(SEVERITIES, Math.random()),
    });
  }
  const grouped = new Map<number, typeof records>();
  for (const rec of records) {
    const arr = grouped.get(rec.svcIdx) ?? [];
    arr.push(rec);
    grouped.set(rec.svcIdx, arr);
  }
  return {
    resourceLogs: services.map((svc, svcIdx) => ({
      resource: { attributes: buildResourceAttributes(svc) },
      scopeLogs: [
        {
          scope: { name: "demo.seed", version: "1.0.0" },
          logRecords: (grouped.get(svcIdx) ?? []).map((rec) => {
            const messages = LOG_MESSAGES[rec.sev.text]!;
            const message = messages[Math.floor(Math.random() * messages.length)]!;
            return {
              timeUnixNano: nano(rec.t),
              severityNumber: rec.sev.number,
              severityText: rec.sev.text,
              body: { stringValue: message },
              attributes: [
                stringAttr("http.method", ["GET", "POST", "PUT", "DELETE"][Math.floor(Math.random() * 4)]!),
                intAttr("http.status_code", rec.sev.text === "ERROR" ? 500 : rec.sev.text === "WARN" ? 429 : 200),
              ],
            };
          }),
        },
      ],
    })),
  };
}

function randHex(bytes: number): string {
  let s = "";
  for (let i = 0; i < bytes * 2; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function buildTraces(opts: Options, services: typeof SERVICES) {
  const now = Date.now();
  const tracesPerSvc = Math.max(5, Math.floor(opts.points / 2));
  return {
    resourceSpans: services.map((svc, svcIdx) => ({
      resource: { attributes: buildResourceAttributes(svc) },
      scopeSpans: [
        {
          scope: { name: "demo.seed", version: "1.0.0" },
          spans: Array.from({ length: tracesPerSvc }, (_, i) => {
            const startMs = now - Math.random() * opts.minutes * 60_000;
            const durationMs = 5 + Math.random() * (50 + svcIdx * 10);
            return {
              traceId: randHex(16),
              spanId: randHex(8),
              name: `${["GET", "POST", "PUT"][i % 3]} /api/v1/${["orders", "items", "users", "cart"][i % 4]}`,
              kind: 2,
              startTimeUnixNano: nano(startMs),
              endTimeUnixNano: nano(startMs + durationMs),
              status: { code: Math.random() < 0.05 ? 2 : 0 },
              attributes: [
                stringAttr("http.method", ["GET", "POST", "PUT"][i % 3]!),
                stringAttr("http.route", `/api/v1/${["orders", "items", "users", "cart"][i % 4]}`),
                intAttr("http.status_code", Math.random() < 0.05 ? 500 : 200),
                doubleAttr("http.duration_ms", durationMs),
              ],
            };
          }),
        },
      ],
    })),
  };
}

async function postOtlp(url: string, projectId: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-superlog-project-id": projectId,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status} ${res.statusText}: ${body}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!opts.projectId) throw new Error("--project-id is required");
  if (!Number.isFinite(opts.minutes) || opts.minutes <= 0) throw new Error("--minutes must be > 0");
  if (!Number.isFinite(opts.points) || opts.points <= 0) throw new Error("--points must be > 0");

  const services = SERVICES.slice(0, opts.services);

  const metrics = buildMetrics(opts, services);
  const logs = buildLogs(opts, services);
  const traces = buildTraces(opts, services);

  console.log(`seeding project=${opts.projectId} into ${opts.collectorUrl}`);
  console.log(
    `  services=${services.length} window=${opts.minutes}m points/series=${opts.points}`,
  );

  await postOtlp(`${opts.collectorUrl}/v1/metrics`, opts.projectId, metrics);
  console.log(`  ✓ metrics`);
  await sleep(50);
  await postOtlp(`${opts.collectorUrl}/v1/logs`, opts.projectId, logs);
  console.log(`  ✓ logs`);
  await sleep(50);
  await postOtlp(`${opts.collectorUrl}/v1/traces`, opts.projectId, traces);
  console.log(`  ✓ traces`);

  console.log(
    `\ndone. ClickHouse should have data within ~5s (collector batch). Refresh the dashboard.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
