import { db, schema } from "@superlog/db";
import { and, desc, eq } from "drizzle-orm";
import type {
  AwsDiagnosticRecorder,
  AwsDiagnosticRun,
  AwsDiagnosticRunDraft,
} from "./aws-diagnostics.js";

const toRun = (
  row: typeof schema.cloudConnectionDiagnosticRuns.$inferSelect,
): AwsDiagnosticRun => ({
  id: row.id,
  connectionId: row.connectionId,
  projectId: row.projectId,
  requestedByUserId: row.requestedByUserId,
  region: row.region,
  status: row.status,
  summary: row.summary,
  checks: row.checks,
  reason: row.reason,
  createdAt: row.createdAt,
});

export function createAwsDiagnosticRecorder(): AwsDiagnosticRecorder {
  return {
    async record(run: AwsDiagnosticRunDraft) {
      const [row] = await db.insert(schema.cloudConnectionDiagnosticRuns).values(run).returning();
      if (!row) throw new Error("failed to record AWS diagnostic");
      return toRun(row);
    },
  };
}

export async function listAwsDiagnosticRuns(
  projectId: string,
  connectionId: string,
  limit = 10,
): Promise<AwsDiagnosticRun[]> {
  const rows = await db.query.cloudConnectionDiagnosticRuns.findMany({
    where: and(
      eq(schema.cloudConnectionDiagnosticRuns.projectId, projectId),
      eq(schema.cloudConnectionDiagnosticRuns.connectionId, connectionId),
    ),
    orderBy: [desc(schema.cloudConnectionDiagnosticRuns.createdAt)],
    limit,
  });
  return rows.map(toRun);
}
