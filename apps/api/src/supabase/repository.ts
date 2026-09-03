import {
  db,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  mintApiKey,
  schema,
} from "@superlog/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type {
  SupabaseConnectionInput,
  SupabaseConnectionRepository,
  SupabaseConnectionView,
  SupabaseGrant,
  SupabaseGrantRepository,
} from "./application.js";

const SUPABASE_SCOPE = "projects:read database:read";

export type SupabaseGrantView = SupabaseGrant & {
  primaryEmail: string;
  username: string;
  tokenExpiresAt: Date | null;
};

export type SupabaseStoredConnectionView = SupabaseConnectionView & {
  grantId: string;
  primaryEmail: string;
  lastPolledAt: Date | null;
  lastMetricsReceivedAt: Date | null;
  lastError: string | null;
};

export type SupabaseGrantSecret = SupabaseGrantView & {
  accessToken: string;
  refreshToken: string | null;
};

export class DrizzleSupabaseRepository
  implements SupabaseConnectionRepository, SupabaseGrantRepository
{
  async upsertGrant(
    input: Parameters<SupabaseGrantRepository["upsertGrant"]>[0],
  ): Promise<SupabaseGrant> {
    const access = encryptIntegrationSecret(input.accessToken);
    const refresh = input.refreshToken ? encryptIntegrationSecret(input.refreshToken) : null;
    const [row] = await db
      .insert(schema.supabaseOauthGrants)
      .values({
        orgId: input.orgId,
        supabaseUserId: input.supabaseUserId,
        primaryEmail: input.primaryEmail,
        username: input.username,
        accessTokenCiphertext: access.ciphertext,
        accessTokenNonce: access.nonce,
        accessTokenKeyVersion: access.keyVersion,
        refreshTokenCiphertext: refresh?.ciphertext ?? null,
        refreshTokenNonce: refresh?.nonce ?? null,
        refreshTokenKeyVersion: refresh?.keyVersion ?? null,
        tokenExpiresAt: input.tokenExpiresAt,
        scope: SUPABASE_SCOPE,
        installedByUserId: input.actorUserId,
      })
      .onConflictDoUpdate({
        target: [schema.supabaseOauthGrants.orgId, schema.supabaseOauthGrants.supabaseUserId],
        set: {
          primaryEmail: input.primaryEmail,
          username: input.username,
          accessTokenCiphertext: access.ciphertext,
          accessTokenNonce: access.nonce,
          accessTokenKeyVersion: access.keyVersion,
          refreshTokenCiphertext: refresh?.ciphertext ?? null,
          refreshTokenNonce: refresh?.nonce ?? null,
          refreshTokenKeyVersion: refresh?.keyVersion ?? null,
          tokenExpiresAt: input.tokenExpiresAt,
          scope: SUPABASE_SCOPE,
          installedByUserId: input.actorUserId,
          revokedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("failed to persist Supabase OAuth grant");
    return toGrant(row);
  }

  async findGrant(orgId: string, grantId: string): Promise<SupabaseGrant | null> {
    const row = await db.query.supabaseOauthGrants.findFirst({
      where: and(
        eq(schema.supabaseOauthGrants.orgId, orgId),
        eq(schema.supabaseOauthGrants.id, grantId),
      ),
    });
    return row ? toGrant(row) : null;
  }

  async listGrants(orgId: string): Promise<SupabaseGrantView[]> {
    const rows = await db.query.supabaseOauthGrants.findMany({
      where: and(
        eq(schema.supabaseOauthGrants.orgId, orgId),
        isNull(schema.supabaseOauthGrants.revokedAt),
      ),
      orderBy: (grant, { asc }) => [asc(grant.primaryEmail)],
    });
    return rows.map((row) => ({
      ...toGrant(row),
      primaryEmail: row.primaryEmail,
      username: row.username,
      tokenExpiresAt: row.tokenExpiresAt,
    }));
  }

  async getGrantSecret(grantId: string): Promise<SupabaseGrantSecret | null> {
    const row = await db.query.supabaseOauthGrants.findFirst({
      where: and(
        eq(schema.supabaseOauthGrants.id, grantId),
        isNull(schema.supabaseOauthGrants.revokedAt),
      ),
    });
    if (!row) return null;
    return {
      ...toGrant(row),
      primaryEmail: row.primaryEmail,
      username: row.username,
      tokenExpiresAt: row.tokenExpiresAt,
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
    };
  }

  async saveGrantTokens(
    grantId: string,
    input: { accessToken: string; refreshToken: string | null; tokenExpiresAt: Date },
  ): Promise<void> {
    const access = encryptIntegrationSecret(input.accessToken);
    const refresh = input.refreshToken ? encryptIntegrationSecret(input.refreshToken) : null;
    await db
      .update(schema.supabaseOauthGrants)
      .set({
        accessTokenCiphertext: access.ciphertext,
        accessTokenNonce: access.nonce,
        accessTokenKeyVersion: access.keyVersion,
        refreshTokenCiphertext: refresh?.ciphertext ?? null,
        refreshTokenNonce: refresh?.nonce ?? null,
        refreshTokenKeyVersion: refresh?.keyVersion ?? null,
        tokenExpiresAt: input.tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.supabaseOauthGrants.id, grantId));
  }

  async upsertConnections(input: {
    projectId: string;
    grantId: string;
    actorUserId: string;
    connections: SupabaseConnectionInput[];
  }): Promise<SupabaseConnectionView[]> {
    const results: SupabaseConnectionView[] = [];
    for (const connection of input.connections) {
      const existing = await db.query.supabaseConnections.findFirst({
        where: and(
          eq(schema.supabaseConnections.projectId, input.projectId),
          eq(schema.supabaseConnections.supabaseProjectRef, connection.projectRef),
        ),
      });
      let key: { id: string; encrypted: ReturnType<typeof encryptIntegrationSecret> } | undefined;
      if (
        !existing ||
        existing.revokedAt ||
        !existing.apiKeyId ||
        !existing.ingestKeyCiphertext ||
        !existing.ingestKeyNonce
      ) {
        const minted = await mintApiKey({
          projectId: input.projectId,
          name: `Supabase ${connection.environment}`,
        });
        key = { id: minted.id, encrypted: encryptIntegrationSecret(minted.plaintext) };
      }
      const [row] = await db
        .insert(schema.supabaseConnections)
        .values({
          projectId: input.projectId,
          grantId: input.grantId,
          supabaseProjectRef: connection.projectRef,
          supabaseProjectName: connection.projectName,
          supabaseOrganizationSlug: connection.organizationSlug,
          region: connection.region,
          environment: connection.environment,
          apiKeyId: key?.id ?? existing?.apiKeyId,
          ingestKeyCiphertext: key?.encrypted.ciphertext ?? existing?.ingestKeyCiphertext,
          ingestKeyNonce: key?.encrypted.nonce ?? existing?.ingestKeyNonce,
          ingestKeyKeyVersion: key?.encrypted.keyVersion ?? existing?.ingestKeyKeyVersion,
          createdByUserId: input.actorUserId,
        })
        .onConflictDoUpdate({
          target: [
            schema.supabaseConnections.projectId,
            schema.supabaseConnections.supabaseProjectRef,
          ],
          set: {
            grantId: input.grantId,
            supabaseProjectName: connection.projectName,
            supabaseOrganizationSlug: connection.organizationSlug,
            region: connection.region,
            environment: connection.environment,
            ...(key
              ? {
                  apiKeyId: key.id,
                  ingestKeyCiphertext: key.encrypted.ciphertext,
                  ingestKeyNonce: key.encrypted.nonce,
                  ingestKeyKeyVersion: key.encrypted.keyVersion,
                }
              : {}),
            lastError: null,
            revokedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("failed to persist Supabase connection");
      results.push(toConnection(row));
    }
    return results;
  }

  async listConnections(projectId: string): Promise<SupabaseStoredConnectionView[]> {
    const rows = await db
      .select({
        connection: schema.supabaseConnections,
        primaryEmail: schema.supabaseOauthGrants.primaryEmail,
      })
      .from(schema.supabaseConnections)
      .innerJoin(
        schema.supabaseOauthGrants,
        eq(schema.supabaseOauthGrants.id, schema.supabaseConnections.grantId),
      )
      .where(
        and(
          eq(schema.supabaseConnections.projectId, projectId),
          isNull(schema.supabaseConnections.revokedAt),
          isNull(schema.supabaseOauthGrants.revokedAt),
        ),
      );
    return rows.map(({ connection, primaryEmail }) => ({
      ...toConnection(connection),
      grantId: connection.grantId,
      primaryEmail,
      lastPolledAt: connection.lastPolledAt,
      lastMetricsReceivedAt: connection.lastMetricsReceivedAt,
      lastError: connection.lastError,
    }));
  }

  async revokeConnection(projectId: string, connectionId: string): Promise<boolean> {
    const now = new Date();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: schema.supabaseConnections.id,
          apiKeyId: schema.supabaseConnections.apiKeyId,
        })
        .from(schema.supabaseConnections)
        .where(
          and(
            eq(schema.supabaseConnections.projectId, projectId),
            eq(schema.supabaseConnections.id, connectionId),
            isNull(schema.supabaseConnections.revokedAt),
          ),
        )
        .limit(1);
      if (!row) return false;
      await tx
        .update(schema.supabaseConnections)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(schema.supabaseConnections.id, row.id));
      if (row.apiKeyId) {
        await tx
          .update(schema.apiKeys)
          .set({ revokedAt: now })
          .where(eq(schema.apiKeys.id, row.apiKeyId));
      }
      return true;
    });
  }

  async revokeGrant(orgId: string, grantId: string): Promise<boolean> {
    const now = new Date();
    return db.transaction(async (tx) => {
      const [grant] = await tx
        .select({ id: schema.supabaseOauthGrants.id })
        .from(schema.supabaseOauthGrants)
        .where(
          and(
            eq(schema.supabaseOauthGrants.orgId, orgId),
            eq(schema.supabaseOauthGrants.id, grantId),
            isNull(schema.supabaseOauthGrants.revokedAt),
          ),
        )
        .limit(1);
      if (!grant) return false;
      const connections = await tx
        .select({
          id: schema.supabaseConnections.id,
          apiKeyId: schema.supabaseConnections.apiKeyId,
        })
        .from(schema.supabaseConnections)
        .where(
          and(
            eq(schema.supabaseConnections.grantId, grant.id),
            isNull(schema.supabaseConnections.revokedAt),
          ),
        );
      await tx
        .update(schema.supabaseConnections)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(schema.supabaseConnections.grantId, grant.id));
      const keyIds = connections.flatMap((connection) =>
        connection.apiKeyId ? [connection.apiKeyId] : [],
      );
      if (keyIds.length > 0) {
        await tx
          .update(schema.apiKeys)
          .set({ revokedAt: now })
          .where(inArray(schema.apiKeys.id, keyIds));
      }
      await tx
        .update(schema.supabaseOauthGrants)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(schema.supabaseOauthGrants.id, grant.id));
      return true;
    });
  }
}

function toGrant(row: typeof schema.supabaseOauthGrants.$inferSelect): SupabaseGrant {
  return { id: row.id, orgId: row.orgId, revokedAt: row.revokedAt };
}

function toConnection(row: typeof schema.supabaseConnections.$inferSelect): SupabaseConnectionView {
  return {
    id: row.id,
    projectRef: row.supabaseProjectRef,
    projectName: row.supabaseProjectName,
    organizationSlug: row.supabaseOrganizationSlug,
    region: row.region,
    environment: row.environment,
  };
}
