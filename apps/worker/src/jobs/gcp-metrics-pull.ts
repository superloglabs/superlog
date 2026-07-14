import { decryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import { GoogleAuth } from "google-auth-library";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";
import {
  type GcpMetricConnection,
  type GcpMetricsPullerStore,
  runGcpMetricsPullOnce,
} from "../gcp/metrics-puller.js";
import { GoogleMonitoringClient } from "../gcp/monitoring-client.js";

const log = logger.child({ scope: "gcp-metrics-pull" });
const DEFAULT_MONTHLY_SERIES_LIMIT = 100_000_000;

function intakeBaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.GCP_METRICS_INTAKE_URL) return env.GCP_METRICS_INTAKE_URL.replace(/\/$/, "");
  return `http://localhost:${env.PROXY_APP_PORT ?? "4000"}`;
}

function monthlyLimit(value: string | undefined): number {
  if (!value) return DEFAULT_MONTHLY_SERIES_LIMIT;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MONTHLY_SERIES_LIMIT;
}

function createStore(db: JobDeps["db"]): GcpMetricsPullerStore {
  return {
    async listConnected(): Promise<GcpMetricConnection[]> {
      const rows = await db.query.gcpConnections.findMany({
        where: and(
          eq(schema.gcpConnections.status, "connected"),
          isNull(schema.gcpConnections.revokedAt),
        ),
      });
      const connections: GcpMetricConnection[] = [];
      for (const row of rows) {
        let ingestKey: string | null = null;
        try {
          if (row.ingestKeyCiphertext && row.ingestKeyNonce) {
            ingestKey = decryptIntegrationSecret({
              ciphertext: row.ingestKeyCiphertext,
              nonce: row.ingestKeyNonce,
              keyVersion: row.ingestKeyKeyVersion ?? 1,
            });
          }
        } catch (error) {
          log.error(
            { connection_id: row.id, err: error instanceof Error ? error.message : String(error) },
            "GCP metrics ingest key decrypt failed",
          );
        }
        connections.push({
          id: row.id,
          projectId: row.projectId,
          gcpProjectId: row.gcpProjectId,
          metricsCursor: row.metricsCursor,
          metricsBudgetMonth: row.metricsBudgetMonth,
          metricsSeriesRead: row.metricsSeriesRead,
          ingestKey,
        });
      }
      return connections;
    },

    async reserveBudget(id, reservation) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            month: schema.gcpConnections.metricsBudgetMonth,
            seriesRead: schema.gcpConnections.metricsSeriesRead,
          })
          .from(schema.gcpConnections)
          .where(eq(schema.gcpConnections.id, id))
          .for("update");
        if (!row) return 0;
        const current = row.month === reservation.month ? row.seriesRead : 0;
        const available = Math.max(0, reservation.monthlyLimit - current);
        const reserved = Math.min(reservation.requested, available);
        if (reserved === 0 && row.month === reservation.month) return 0;
        await tx
          .update(schema.gcpConnections)
          .set({
            metricsBudgetMonth: reservation.month,
            metricsSeriesRead: current + reserved,
            updatedAt: new Date(),
          })
          .where(eq(schema.gcpConnections.id, id));
        return reserved;
      });
    },

    async refundBudget(id, refund) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            month: schema.gcpConnections.metricsBudgetMonth,
            seriesRead: schema.gcpConnections.metricsSeriesRead,
          })
          .from(schema.gcpConnections)
          .where(eq(schema.gcpConnections.id, id))
          .for("update");
        if (!row || row.month !== refund.month || refund.series === 0) return;
        await tx
          .update(schema.gcpConnections)
          .set({
            metricsSeriesRead: Math.max(0, row.seriesRead - refund.series),
            updatedAt: new Date(),
          })
          .where(eq(schema.gcpConnections.id, id));
      });
    },

    async saveCursor(id, cursor) {
      await db
        .update(schema.gcpConnections)
        .set({ metricsCursor: cursor, lastMetricsReceivedAt: cursor, updatedAt: new Date() })
        .where(eq(schema.gcpConnections.id, id));
    },
  };
}

export const job: JobDefinition = {
  name: "gcp-metrics-pull",
  schedule: "*/5 * * * *",
  create: (deps) => {
    const integrationProjectId = process.env.GCP_INTEGRATION_PROJECT_ID;
    if (!integrationProjectId) {
      log.info({}, "GCP_INTEGRATION_PROJECT_ID not set — GCP metrics pull disabled");
      return null;
    }
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      projectId: integrationProjectId,
    });
    const scopes = ["https://www.googleapis.com/auth/cloud-platform"];
    const externalAccount = process.env.GCP_WORKLOAD_IDENTITY_CONFIG;
    const monitoring = new GoogleMonitoringClient({
      integrationProjectId,
      accessToken: async () => {
        const client = externalAccount
          ? auth.fromJSON({ ...JSON.parse(externalAccount), scopes })
          : await auth.getClient();
        const token = await client.getAccessToken();
        if (!token.token) throw new Error("Google ADC did not return an access token");
        return token.token;
      },
    });
    const store = createStore(deps.db);
    const intake = intakeBaseUrl(process.env);
    const limit = monthlyLimit(process.env.GCP_METRICS_MONTHLY_SERIES_LIMIT);

    return async () => {
      const stats = await runGcpMetricsPullOnce({
        store,
        monitoring,
        monthlySeriesLimit: limit,
        forward: async ({ payload, ingestKey }) => {
          const response = await fetch(`${intake}/gcp/pull/metrics`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${ingestKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            log.warn({ status: response.status }, "GCP metric intake rejected a batch");
          }
          return response.ok;
        },
      });
      if (stats.connections > 0) {
        log.info({ ...stats, monthly_series_limit: limit }, "GCP metrics pull complete");
      }
    };
  },
};
