// Scheduled job: (re)build the service-map topology for projects. Picks up rows a
// user asked to refresh (refreshRequestedAt > generatedAt), connected projects
// that have no map yet, and maps older than a day. For each: build the
// deterministic graph from inventory + telemetry, run the LLM grouping pass, and
// persist. The handler does one bounded pass; pg-boss owns the schedule.

import { schema } from "@superlog/db";
import type { Topology } from "@superlog/topology";
import { and, eq, exists, isNull, lt, or, sql } from "drizzle-orm";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";
import { buildProjectTopology } from "../topology/build.js";
import { serviceGraphFromClickHouse } from "../topology/clickhouse.js";
import { enrichProjectTopology } from "../topology/enrich.js";

const MAX_PER_TICK = 8;
const STALE_AFTER_HOURS = 24;
const scope = "jobs.build-topologies";

async function selectCandidates(db: JobDeps["db"], now: Date): Promise<string[]> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_HOURS * 3600_000);

  // 1) Existing rows that need a (re)build and aren't already in flight.
  const pending = await db
    .select({ projectId: schema.projectTopologies.projectId })
    .from(schema.projectTopologies)
    .where(
      and(
        sql`${schema.projectTopologies.status} <> 'generating'`,
        // Only rebuild while the project still has a connected source — a
        // disconnected project's inventory is empty, so a rebuild is wasted work
        // (and would crowd out connected projects on the bounded tick).
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.cloudConnections)
            .where(
              and(
                eq(schema.cloudConnections.projectId, schema.projectTopologies.projectId),
                eq(schema.cloudConnections.status, "connected"),
              ),
            ),
        ),
        or(
          isNull(schema.projectTopologies.generatedAt),
          sql`${schema.projectTopologies.refreshRequestedAt} > ${schema.projectTopologies.generatedAt}`,
          lt(schema.projectTopologies.generatedAt, staleBefore),
        ),
      ),
    )
    .limit(MAX_PER_TICK);

  // 2) Connected projects that have no topology row at all → seed them.
  const connected = await db
    .selectDistinct({ projectId: schema.cloudConnections.projectId })
    .from(schema.cloudConnections)
    .leftJoin(
      schema.projectTopologies,
      eq(schema.projectTopologies.projectId, schema.cloudConnections.projectId),
    )
    .where(
      and(eq(schema.cloudConnections.status, "connected"), isNull(schema.projectTopologies.id)),
    )
    .limit(MAX_PER_TICK);

  const ids = new Set<string>();
  for (const r of [...pending, ...connected]) ids.add(r.projectId);
  return [...ids].slice(0, MAX_PER_TICK);
}

async function buildOne(deps: JobDeps, projectId: string): Promise<void> {
  const project = await deps.db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
  });
  if (!project) return;

  // Claim the row (insert if missing) and mark in-flight.
  await deps.db
    .insert(schema.projectTopologies)
    .values({ projectId, status: "generating" })
    .onConflictDoUpdate({
      target: schema.projectTopologies.projectId,
      set: { status: "generating", updatedAt: new Date() },
    });

  try {
    const graph: Topology = await buildProjectTopology(
      {
        listResources: async (pid) => {
          const rows = await deps.db.query.cloudResources.findMany({
            where: and(
              eq(schema.cloudResources.projectId, pid),
              isNull(schema.cloudResources.removedAt),
            ),
          });
          return rows.map((r) => ({
            arn: r.arn,
            service: r.service,
            resourceType: r.resourceType,
            name: r.name,
            region: r.region,
            accountId: r.accountId,
            config: r.config as Record<string, unknown> | null,
          }));
        },
        serviceGraph: (pid) => serviceGraphFromClickHouse(deps.clickhouse, pid),
      },
      projectId,
    );

    const enrichment = await enrichProjectTopology(graph, { orgId: project.orgId, projectId });

    await deps.db
      .update(schema.projectTopologies)
      .set({
        graph,
        enrichment,
        status: "idle",
        error: null,
        generatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.projectTopologies.projectId, projectId));
    logger.info(
      { scope, projectId, nodes: graph.nodes.length, enriched: !!enrichment },
      "topology built",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db
      .update(schema.projectTopologies)
      .set({ status: "error", error: message, updatedAt: new Date() })
      .where(eq(schema.projectTopologies.projectId, projectId))
      .catch(() => {});
    logger.warn({ scope, projectId, err: message }, "topology build failed");
  }
}

export const job: JobDefinition = {
  name: "build-topologies",
  schedule: "*/5 * * * *",
  create: (deps: JobDeps) => async () => {
    const candidates = await selectCandidates(deps.db, new Date());
    for (const projectId of candidates) await buildOne(deps, projectId);
    if (candidates.length > 0)
      logger.info({ scope, count: candidates.length }, "topology build pass complete");
  },
};
