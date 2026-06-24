// ClickHouse reads for topology building: the observed cross-service call graph
// and outbound client-span peers, scoped to a project. Mirrors the query shape
// in apps/api/src/mcp/clickhouse.ts (parameterised, project_id + time window).

import type { ClickHouseClient } from "@clickhouse/client";
import type { ServiceGraph } from "@superlog/topology";

type Ch = Pick<ClickHouseClient, "query">;

const PROJECT_FILTER = "ResourceAttributes['superlog.project_id'] = {projectId:String}";

async function rows<T>(ch: Ch, query: string, params: Record<string, unknown>): Promise<T[]> {
  const r = await ch.query({ query, query_params: params, format: "JSONEachRow" });
  return r.json<T>();
}

/**
 * Build a ServiceGraph from telemetry: distinct emitting services, observed
 * cross-service calls (parent.ServiceName → child.ServiceName), and outbound
 * client-span peers (db / messaging / http). Bounded windows + row limits keep
 * it cheap.
 */
export async function serviceGraphFromClickHouse(
  ch: Ch,
  projectId: string,
  opts: { sinceHours?: number } = {},
): Promise<ServiceGraph> {
  // Default to a short window: the cross-service self-join is O(spans²)-ish and
  // times out over 24h on high-volume projects. A few hours is plenty to observe
  // the live service graph.
  const sinceHours = opts.sinceHours ?? 6;
  const params = { projectId, sinceHours };

  const services = await rows<{ name: string; spans: string }>(
    ch,
    `SELECT ServiceName AS name, count() AS spans
       FROM otel_traces
      WHERE Timestamp > now() - INTERVAL {sinceHours:UInt32} HOUR
        AND ${PROJECT_FILTER} AND ServiceName != ''
      GROUP BY name ORDER BY spans DESC LIMIT 200`,
    params,
  );

  const edges = await rows<{ src: string; dst: string; calls: string }>(
    ch,
    `SELECT p.ServiceName AS src, c.ServiceName AS dst, count() AS calls
       FROM otel_traces AS c
       INNER JOIN otel_traces AS p ON c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId
      WHERE c.Timestamp > now() - INTERVAL {sinceHours:UInt32} HOUR
        AND p.Timestamp > now() - INTERVAL {sinceHours:UInt32} HOUR
        AND c.${PROJECT_FILTER} AND p.${PROJECT_FILTER}
        AND c.ServiceName != p.ServiceName AND c.ServiceName != '' AND p.ServiceName != ''
      GROUP BY src, dst ORDER BY calls DESC LIMIT 500
      SETTINGS max_execution_time = 25`,
    params,
  );

  const peerRows = await rows<{
    from: string;
    db: string;
    msg: string;
    peer: string;
    calls: string;
  }>(
    ch,
    `SELECT ServiceName AS from,
            SpanAttributes['db.system'] AS db,
            SpanAttributes['messaging.system'] AS msg,
            SpanAttributes['server.address'] AS peer,
            count() AS calls
       FROM otel_traces
      WHERE Timestamp > now() - INTERVAL {sinceHours:UInt32} HOUR
        AND ${PROJECT_FILTER} AND SpanKind = 'Client'
        AND (SpanAttributes['db.system'] != '' OR SpanAttributes['messaging.system'] != '' OR SpanAttributes['server.address'] != '')
      GROUP BY from, db, msg, peer ORDER BY calls DESC LIMIT 500`,
    params,
  );

  const externalDeps: ServiceGraph["externalDeps"] = [];
  for (const r of peerRows) {
    if (!r.from) continue;
    const [target, peerKind] = r.db
      ? [r.db, "db" as const]
      : r.msg
        ? [r.msg, "messaging" as const]
        : [r.peer, "http" as const];
    if (!target) continue;
    externalDeps.push({ from: r.from, target, peerKind, calls: Number(r.calls) });
  }

  return {
    services: services.map((s) => ({ name: s.name, spans: Number(s.spans) })),
    edges: edges.map((e) => ({ from: e.src, to: e.dst, calls: Number(e.calls) })),
    externalDeps,
  };
}
