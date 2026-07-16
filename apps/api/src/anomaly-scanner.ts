import { db, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  parseAnomalyScannerSettingsPatch,
  serializeAnomalyScanRun,
} from "./anomaly-scanner-service.js";
import { requireProjectManagerContext } from "./org-authorization-http.js";
import { resolveActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; orgId: string | null };

type AnomalyScannerDependencies = {
  requireProjectManagerContext: typeof requireProjectManagerContext;
};

const defaultDependencies: AnomalyScannerDependencies = { requireProjectManagerContext };

export function mountAnomalyScanner(
  app: Hono<{ Variables: Vars }>,
  dependencies: AnomalyScannerDependencies = defaultDependencies,
): void {
  app.get("/api/projects/:projectId/anomaly-scanner", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAnomalyScannerAccess(c, projectId);
    const [settings, runs] = await Promise.all([
      loadSettings(projectId),
      db.query.anomalyScanRuns.findMany({
        where: eq(schema.anomalyScanRuns.projectId, projectId),
        orderBy: (scanRuns, { desc }) => [desc(scanRuns.startedAt)],
        limit: 50,
      }),
    ]);
    return c.json({ settings, scans: runs.map(serializeAnomalyScanRun) });
  });

  app.get("/api/projects/:projectId/anomaly-scanner/scans/:scanId", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAnomalyScannerAccess(c, projectId);
    const run = await db.query.anomalyScanRuns.findFirst({
      where: and(
        eq(schema.anomalyScanRuns.id, c.req.param("scanId")),
        eq(schema.anomalyScanRuns.projectId, projectId),
      ),
    });
    if (!run) throw new HTTPException(404, { message: "scan not found" });
    return c.json(serializeAnomalyScanRun(run));
  });

  app.patch("/api/projects/:projectId/anomaly-scanner", async (c) => {
    const projectId = c.req.param("projectId");
    await dependencies.requireProjectManagerContext(c, projectId);
    await requireAnomalyScannerAccess(c, projectId);
    const parsed = parseAnomalyScannerSettingsPatch(await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HTTPException(400, { message: parsed.error });
    const patch = parsed.value;
    const values = {
      ...(patch.enabled === undefined ? {} : { anomalyScannerEnabled: patch.enabled }),
      ...(patch.cadenceHours === undefined
        ? {}
        : { anomalyScannerCadenceHours: patch.cadenceHours }),
      ...(patch.observationMinutes === undefined
        ? {}
        : { anomalyScannerObservationMinutes: patch.observationMinutes }),
      ...(patch.baselineHours === undefined
        ? {}
        : { anomalyScannerBaselineHours: patch.baselineHours }),
    };
    await db
      .insert(schema.projectAutomationSettings)
      .values({ projectId, ...values })
      .onConflictDoUpdate({
        target: schema.projectAutomationSettings.projectId,
        set: { ...values, updatedAt: new Date() },
      });
    return c.json(await loadSettings(projectId));
  });
}

async function requireAnomalyScannerAccess(
  c: Context<{ Variables: Vars }>,
  projectId: string,
): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
    columns: { orgId: true },
  });
  if (!project) throw new HTTPException(404, { message: "project not found" });
  const ctx = await resolveActiveOrgContext({
    userId: c.var.userId,
    preferredOrgId: c.var.orgId,
  });
  if (project.orgId !== ctx.org.id) throw new HTTPException(403, { message: "forbidden" });
  const flag = await db.query.orgAgentSettings.findFirst({
    where: eq(schema.orgAgentSettings.orgId, ctx.org.id),
    columns: { anomalyScannerEnabled: true },
  });
  if (!flag?.anomalyScannerEnabled) {
    throw new HTTPException(404, { message: "anomaly scanner is not enabled" });
  }
}

async function loadSettings(projectId: string) {
  const row = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
    columns: {
      anomalyScannerEnabled: true,
      anomalyScannerCadenceHours: true,
      anomalyScannerObservationMinutes: true,
      anomalyScannerBaselineHours: true,
    },
  });
  return {
    enabled: row?.anomalyScannerEnabled ?? true,
    cadenceHours: row?.anomalyScannerCadenceHours ?? 6,
    observationMinutes: row?.anomalyScannerObservationMinutes ?? 60,
    baselineHours: row?.anomalyScannerBaselineHours ?? 24,
  };
}
