import { type Counter, metrics } from "@opentelemetry/api";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";

const meter = metrics.getMeter("@superlog/proxy/tenant");

const tracesCounter: Counter = meter.createCounter("superlog.tenant.traces.received", {
  description: "OTLP /v1/traces requests received from a tenant org (per-request, not per-span).",
});
const logsCounter: Counter = meter.createCounter("superlog.tenant.logs.received", {
  description: "OTLP /v1/logs requests received from a tenant org (per-request, not per-record).",
});
const metricsCounter: Counter = meter.createCounter("superlog.tenant.metric_points.received", {
  description:
    "OTLP /v1/metrics requests received from a tenant org (per-request, not per-datapoint).",
});

const COUNTER_BY_PATH: Record<string, Counter> = {
  "/v1/traces": tracesCounter,
  "/v1/logs": logsCounter,
  "/v1/metrics": metricsCounter,
};

export type OrgInfo = { orgId: string; orgName: string } | null;

const PROJECT_TTL_MS = 5 * 60 * 1000;
const projectCache = new Map<string, { value: OrgInfo; expiresAt: number }>();

const SELF_ORG_IDS = new Set(
  (process.env.SUPERLOG_SELF_ORG_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export async function lookupOrgForProject(projectId: string): Promise<OrgInfo> {
  const cached = projectCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
    columns: { orgId: true },
  });
  let info: OrgInfo = null;
  if (project) {
    const org = await db.query.orgs.findFirst({
      where: eq(schema.orgs.id, project.orgId),
      columns: { id: true, name: true },
    });
    if (org) info = { orgId: org.id, orgName: org.name };
  }
  projectCache.set(projectId, { value: info, expiresAt: Date.now() + PROJECT_TTL_MS });
  return info;
}

export async function recordIngestRequest(path: string, projectId: string): Promise<void> {
  const counter = COUNTER_BY_PATH[path];
  if (!counter) return;
  const info = await lookupOrgForProject(projectId);
  if (!info) return;
  if (SELF_ORG_IDS.has(info.orgId)) return;
  counter.add(1, {
    "tenant.org.id": info.orgId,
    "tenant.org.name": info.orgName,
  });
}
