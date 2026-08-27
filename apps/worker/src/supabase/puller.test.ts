import { strict as assert } from "node:assert";
import test from "node:test";
import {
  SUPABASE_QUERY_METRICS_SQL,
  type SupabasePullerStore,
  pgStatStatementsToOtlp,
  runSupabasePullOnce,
} from "./puller.js";

test("the query-metrics read uses only schema-qualified pg_stat_statements objects", () => {
  assert.match(SUPABASE_QUERY_METRICS_SQL, /extensions\.pg_stat_statements/);
  assert.match(SUPABASE_QUERY_METRICS_SQL, /extensions\.pg_stat_statements_info/);
  assert.match(SUPABASE_QUERY_METRICS_SQL, /pg_catalog\.pg_database/);
  assert.match(SUPABASE_QUERY_METRICS_SQL, /pg_catalog\.pg_roles/);
  assert.match(SUPABASE_QUERY_METRICS_SQL, /limit 100/i);
});

test("pg_stat_statements rows become cumulative OTLP query metrics with environment identity", () => {
  const payload = pgStatStatementsToOtlp(
    [
      {
        queryid: "42",
        query: "select * from orders where id = $1",
        calls: "5",
        rows: "3",
        total_exec_time: 1250,
        total_plan_time: 250,
        mean_exec_time: 250,
        shared_blks_hit: "9",
        shared_blks_read: "2",
        temp_blks_read: "1",
        temp_blks_written: "0",
        datname: "postgres",
        rolname: "app_user",
        stats_reset: "2026-08-27T10:00:00.000Z",
      },
    ],
    {
      projectRef: "abcdefghijklmnopqrst",
      projectName: "Acme production",
      organizationSlug: "acme",
      region: "eu-west-1",
      environment: "production",
    },
    new Date("2026-08-27T12:00:00.000Z"),
  );

  const resource = payload.resourceMetrics[0];
  assert.ok(resource);
  assert.deepEqual(
    Object.fromEntries(
      resource.resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
    ),
    {
      "service.name": "supabase-postgres",
      "service.instance.id": "abcdefghijklmnopqrst",
      "deployment.environment.name": "production",
      "telemetry.source": "supabase",
      "supabase.project.ref": "abcdefghijklmnopqrst",
      "supabase.project.name": "Acme production",
      "supabase.organization.slug": "acme",
      "cloud.region": "eu-west-1",
    },
  );
  const metrics = resource.scopeMetrics[0]?.metrics ?? [];
  const calls = metrics.find((metric) => metric.name === "postgresql.query.calls")?.sum
    .dataPoints[0] as
    | { asInt?: string; attributes?: Array<{ key: string; value: { stringValue: string } }> }
    | undefined;
  const executionTime = metrics.find((metric) => metric.name === "postgresql.query.execution.time")
    ?.sum.dataPoints[0] as { asDouble?: number } | undefined;
  assert.equal(calls?.asInt, "5");
  assert.equal(executionTime?.asDouble, 1.5);
  assert.equal(
    calls?.attributes?.some(
      (attribute) => attribute.key === "postgresql.query.mean_execution_time_ms",
    ),
    false,
  );
});

test("one OAuth grant refresh is shared by all of its connected Supabase projects", async () => {
  const events: string[] = [];
  const store: SupabasePullerStore = {
    async listActiveGrants() {
      return [
        {
          id: "grant-1",
          accessToken: "old-access",
          refreshToken: "refresh",
          tokenExpiresAt: new Date("2026-08-27T12:01:00.000Z"),
          connections: [
            connection("connection-1", "project-one"),
            connection("connection-2", "project-two"),
          ],
        },
      ];
    },
    async saveGrantTokens() {
      events.push("save-token");
    },
    async markConnectionSuccess(id) {
      events.push(`success:${id}`);
    },
    async markConnectionFailure(id) {
      events.push(`failure:${id}`);
    },
  };
  let refreshes = 0;
  const stats = await runSupabasePullOnce({
    store,
    reader: {
      async refreshAccessToken() {
        refreshes += 1;
        return { accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 3600 };
      },
      async runReadOnlyQuery(projectRef, sql, accessToken) {
        assert.equal(accessToken, "new-access");
        events.push(`query:${projectRef}`);
        assert.equal(sql, SUPABASE_QUERY_METRICS_SQL);
        return [];
      },
    },
    async forward({ ingestKey }) {
      events.push(`forward:${ingestKey}`);
      return true;
    },
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });

  assert.equal(refreshes, 1);
  assert.deepEqual(stats, { grants: 1, connections: 2, statements: 0, errors: 0 });
  assert.deepEqual(events, [
    "save-token",
    "query:project-one",
    "forward:ingest-connection-1",
    "success:connection-1",
    "query:project-two",
    "forward:ingest-connection-2",
    "success:connection-2",
  ]);
});

test("the pull deadline signal is forwarded to every external request", async () => {
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  const store: SupabasePullerStore = {
    async listActiveGrants() {
      return [
        {
          id: "grant-1",
          accessToken: "access",
          refreshToken: null,
          tokenExpiresAt: new Date("2026-08-27T13:00:00.000Z"),
          connections: [connection("connection-1", "project-one")],
        },
      ];
    },
    async saveGrantTokens() {},
    async markConnectionSuccess() {},
    async markConnectionFailure() {},
  };

  await runSupabasePullOnce({
    store,
    reader: {
      async refreshAccessToken(_refreshToken, signal) {
        signals.push(signal);
        return { accessToken: "access", refreshToken: null, expiresInSeconds: 3600 };
      },
      async runReadOnlyQuery(_projectRef, _sql, _accessToken, signal) {
        signals.push(signal);
        return [];
      },
    },
    async forward({ signal }) {
      signals.push(signal);
      return true;
    },
    signal: controller.signal,
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });

  assert.deepEqual(signals, [controller.signal, controller.signal]);
});

function connection(id: string, projectRef: string) {
  return {
    id,
    projectRef,
    projectName: projectRef,
    organizationSlug: "acme",
    region: "eu-west-1",
    environment: "production",
    ingestKey: `ingest-${id}`,
  };
}
