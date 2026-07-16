import assert from "node:assert/strict";
import test from "node:test";
import type { schema } from "@superlog/db";
import {
  parseAnomalyScannerSettingsPatch,
  serializeAnomalyScanRun,
} from "./anomaly-scanner-service.js";

test("anomaly scanner settings reject unsupported cadence and window values", () => {
  const parsed = parseAnomalyScannerSettingsPatch({
    enabled: true,
    cadenceHours: 2,
    observationMinutes: 60,
    baselineHours: 24,
  });

  assert.deepEqual(parsed, {
    ok: false,
    error: "cadenceHours must be one of: 1, 3, 6, 12, 24",
  });
});

test("scan detail serialization retains its structured audit", () => {
  const audit = {
    version: 1,
    baselineSince: "2026-07-13T11:00:00.000Z",
    observedSince: "2026-07-14T11:00:00.000Z",
    observedUntil: "2026-07-14T12:00:00.000Z",
    metrics: [],
    repositories: ["acme/worker"],
    alertsCompared: [],
    incidentsCompared: [],
    decisions: [],
  } satisfies schema.AnomalyScanAudit;
  const serialized = serializeAnomalyScanRun({
    id: "scan-1",
    orgId: "org-1",
    projectId: "project-1",
    status: "completed",
    metricSeriesScanned: 2,
    findingsCount: 0,
    incidentsOpened: 0,
    incidentsDeduped: 0,
    findings: [],
    audit,
    error: null,
    startedAt: new Date("2026-07-14T12:00:00.000Z"),
    completedAt: new Date("2026-07-14T12:03:00.000Z"),
  });

  assert.deepEqual(serialized.audit, audit);
});
