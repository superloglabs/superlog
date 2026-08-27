import { decryptIntegrationSecret, encryptIntegrationSecret, schema } from "@superlog/db";
import { SupabaseManagementClient, supabaseConfigFromEnv } from "@superlog/supabase";
import { and, eq, isNull } from "drizzle-orm";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";
import {
  type SupabasePullGrant,
  type SupabasePullerStore,
  type SupabaseQueryMetricsRow,
  runSupabasePullOnce,
} from "../supabase/puller.js";

const log = logger.child({ scope: "supabase-metrics-pull" });

type SupabaseJobOptions = {
  env?: NodeJS.ProcessEnv;
  client?: SupabaseManagementClient;
};

export function isSupabaseMetricIntakeAcknowledged(status: number): boolean {
  return (status >= 200 && status < 300) || [400, 402, 413].includes(status);
}

export function createSupabaseMetricsPullJob(options: SupabaseJobOptions = {}): JobDefinition {
  const env = options.env ?? process.env;
  return {
    name: "supabase-metrics-pull",
    schedule: "*/5 * * * *",
    policy: "exclusive",
    expireInSeconds: 240,
    create: (deps) => {
      const config = supabaseConfigFromEnv(env);
      if (!config || !env.AGENT_SECRETS_KEY) {
        log.info({}, "Supabase OAuth or secret storage not configured — metrics pull disabled");
        return null;
      }
      const client = options.client ?? new SupabaseManagementClient();
      const store = createStore(deps.db);
      const intake = intakeBaseUrl(env);

      return async () => {
        const stats = await runSupabasePullOnce({
          store,
          reader: {
            refreshAccessToken: (refreshToken) =>
              client.refreshAccessToken({ config, refreshToken }),
            async runReadOnlyQuery(projectRef, query, accessToken) {
              return parseQueryMetricsRows(
                await client.runReadOnlyQuery({ projectRef, query, accessToken }),
              );
            },
          },
          async forward({ payload, ingestKey }) {
            const response = await fetch(`${intake}/supabase/pull/metrics`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${ingestKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(payload),
            });
            if (!response.ok) {
              log.warn({ status: response.status }, "Supabase metric intake rejected a payload");
            }
            return isSupabaseMetricIntakeAcknowledged(response.status);
          },
        });
        if (stats.connections > 0) log.info(stats, "Supabase metrics pull complete");
      };
    },
  };
}

function createStore(db: JobDeps["db"]): SupabasePullerStore {
  return {
    async listActiveGrants() {
      const rows = await db
        .select({
          grantId: schema.supabaseOauthGrants.id,
          accessTokenCiphertext: schema.supabaseOauthGrants.accessTokenCiphertext,
          accessTokenNonce: schema.supabaseOauthGrants.accessTokenNonce,
          accessTokenKeyVersion: schema.supabaseOauthGrants.accessTokenKeyVersion,
          refreshTokenCiphertext: schema.supabaseOauthGrants.refreshTokenCiphertext,
          refreshTokenNonce: schema.supabaseOauthGrants.refreshTokenNonce,
          refreshTokenKeyVersion: schema.supabaseOauthGrants.refreshTokenKeyVersion,
          tokenExpiresAt: schema.supabaseOauthGrants.tokenExpiresAt,
          connectionId: schema.supabaseConnections.id,
          projectRef: schema.supabaseConnections.supabaseProjectRef,
          projectName: schema.supabaseConnections.supabaseProjectName,
          organizationSlug: schema.supabaseConnections.supabaseOrganizationSlug,
          region: schema.supabaseConnections.region,
          environment: schema.supabaseConnections.environment,
          ingestKeyCiphertext: schema.supabaseConnections.ingestKeyCiphertext,
          ingestKeyNonce: schema.supabaseConnections.ingestKeyNonce,
          ingestKeyKeyVersion: schema.supabaseConnections.ingestKeyKeyVersion,
        })
        .from(schema.supabaseOauthGrants)
        .innerJoin(
          schema.supabaseConnections,
          eq(schema.supabaseConnections.grantId, schema.supabaseOauthGrants.id),
        )
        .where(
          and(
            isNull(schema.supabaseOauthGrants.revokedAt),
            isNull(schema.supabaseConnections.revokedAt),
          ),
        );
      const grants = new Map<string, SupabasePullGrant>();
      for (const row of rows) {
        try {
          let grant = grants.get(row.grantId);
          if (!grant) {
            grant = {
              id: row.grantId,
              accessToken: decryptIntegrationSecret({
                ciphertext: row.accessTokenCiphertext,
                nonce: row.accessTokenNonce,
                keyVersion: row.accessTokenKeyVersion,
              }),
              refreshToken:
                row.refreshTokenCiphertext && row.refreshTokenNonce
                  ? decryptIntegrationSecret({
                      ciphertext: row.refreshTokenCiphertext,
                      nonce: row.refreshTokenNonce,
                      keyVersion: row.refreshTokenKeyVersion ?? 1,
                    })
                  : null,
              tokenExpiresAt: row.tokenExpiresAt,
              connections: [],
            };
            grants.set(row.grantId, grant);
          }
          grant.connections.push({
            id: row.connectionId,
            projectRef: row.projectRef,
            projectName: row.projectName,
            organizationSlug: row.organizationSlug,
            region: row.region,
            environment: row.environment,
            ingestKey:
              row.ingestKeyCiphertext && row.ingestKeyNonce
                ? decryptIntegrationSecret({
                    ciphertext: row.ingestKeyCiphertext,
                    nonce: row.ingestKeyNonce,
                    keyVersion: row.ingestKeyKeyVersion ?? 1,
                  })
                : null,
          });
        } catch (error) {
          log.error(
            {
              grant_id: row.grantId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Supabase integration secret decrypt failed",
          );
          grants.delete(row.grantId);
        }
      }
      return [...grants.values()];
    },

    async saveGrantTokens(grantId, token) {
      const access = encryptIntegrationSecret(token.accessToken);
      const refresh = token.refreshToken ? encryptIntegrationSecret(token.refreshToken) : null;
      await db
        .update(schema.supabaseOauthGrants)
        .set({
          accessTokenCiphertext: access.ciphertext,
          accessTokenNonce: access.nonce,
          accessTokenKeyVersion: access.keyVersion,
          refreshTokenCiphertext: refresh?.ciphertext ?? null,
          refreshTokenNonce: refresh?.nonce ?? null,
          refreshTokenKeyVersion: refresh?.keyVersion ?? null,
          tokenExpiresAt: token.tokenExpiresAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.supabaseOauthGrants.id, grantId));
    },

    async markConnectionSuccess(connectionId, polledAt, receivedMetrics) {
      await db
        .update(schema.supabaseConnections)
        .set({
          lastPolledAt: polledAt,
          ...(receivedMetrics ? { lastMetricsReceivedAt: polledAt } : {}),
          lastError: null,
          updatedAt: polledAt,
        })
        .where(eq(schema.supabaseConnections.id, connectionId));
    },

    async markConnectionFailure(connectionId, error, polledAt) {
      await db
        .update(schema.supabaseConnections)
        .set({ lastPolledAt: polledAt, lastError: error, updatedAt: polledAt })
        .where(eq(schema.supabaseConnections.id, connectionId));
    },
  };
}

function intakeBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.SUPABASE_INTAKE_URL ?? `http://localhost:${env.PROXY_APP_PORT ?? "4000"}`).replace(
    /\/$/,
    "",
  );
}

function parseQueryMetricsRows(rows: Array<Record<string, unknown>>): SupabaseQueryMetricsRow[] {
  return rows.map((row) => ({
    queryid: requiredString(row.queryid, "queryid"),
    query: requiredString(row.query, "query"),
    calls: requiredInteger(row.calls, "calls"),
    rows: requiredInteger(row.rows, "rows"),
    total_exec_time: requiredNumber(row.total_exec_time, "total_exec_time"),
    total_plan_time: requiredNumber(row.total_plan_time, "total_plan_time"),
    mean_exec_time: requiredNumber(row.mean_exec_time, "mean_exec_time"),
    shared_blks_hit: requiredInteger(row.shared_blks_hit, "shared_blks_hit"),
    shared_blks_read: requiredInteger(row.shared_blks_read, "shared_blks_read"),
    temp_blks_read: requiredInteger(row.temp_blks_read, "temp_blks_read"),
    temp_blks_written: requiredInteger(row.temp_blks_written, "temp_blks_written"),
    datname: requiredString(row.datname, "datname"),
    rolname: requiredString(row.rolname, "rolname"),
    stats_reset: requiredString(row.stats_reset, "stats_reset"),
  }));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Supabase query metric ${field} is invalid`);
  return value;
}

function requiredInteger(value: unknown, field: string): string {
  const stringValue = typeof value === "number" ? String(value) : requiredString(value, field);
  if (!/^\d+$/.test(stringValue)) throw new Error(`Supabase query metric ${field} is invalid`);
  return stringValue;
}

function requiredNumber(value: unknown, field: string): number {
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue < 0) {
    throw new Error(`Supabase query metric ${field} is invalid`);
  }
  return numberValue;
}

export const job = createSupabaseMetricsPullJob();
