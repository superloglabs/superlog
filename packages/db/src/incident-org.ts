import { eq } from "drizzle-orm";
import { type DB, db } from "./client.js";
import * as schema from "./schema.js";

/**
 * Resolve the org that owns an incident, via incident → project → org — the
 * same join the worker's tenant-metrics.ts uses. Returns null when the incident
 * (or its project/org) can't be resolved, so callers can skip rather than
 * fabricate data. Shared by the worker and API PR-metric emitters so the join
 * lives in one place.
 */
export async function resolveIncidentOrg(
  incidentId: string,
  database: DB = db,
): Promise<{ id: string; name: string } | null> {
  const rows = await database
    .select({ id: schema.orgs.id, name: schema.orgs.name })
    .from(schema.incidents)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.incidents.projectId))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.projects.orgId))
    .where(eq(schema.incidents.id, incidentId))
    .limit(1);
  return rows[0] ?? null;
}
