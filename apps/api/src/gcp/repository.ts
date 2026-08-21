import { db, encryptIntegrationSecret, mintApiKey, schema } from "@superlog/db";
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type {
  GcpConnectionRecord,
  GcpConnectionRepository,
  ProvisionedGcpConnection,
} from "./domain.js";

type Row = typeof schema.gcpConnections.$inferSelect;

const toDomain = (row: Row): GcpConnectionRecord => ({ ...row });

export class DrizzleGcpConnectionRepository implements GcpConnectionRepository {
  async create(input: {
    projectId: string;
    gcpProjectId: string;
    readerServiceAccountEmail: string;
    createdBy: string;
  }): Promise<GcpConnectionRecord> {
    const [inserted] = await db
      .insert(schema.gcpConnections)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (inserted) return toDomain(inserted);
    const active = await db.query.gcpConnections.findFirst({
      where: and(
        eq(schema.gcpConnections.projectId, input.projectId),
        eq(schema.gcpConnections.gcpProjectId, input.gcpProjectId),
        isNull(schema.gcpConnections.revokedAt),
      ),
    });
    if (!active) throw new Error("failed to create GCP connection");
    return toDomain(active);
  }

  async findById(id: string): Promise<GcpConnectionRecord | null> {
    const row = await db.query.gcpConnections.findFirst({
      where: eq(schema.gcpConnections.id, id),
    });
    return row ? toDomain(row) : null;
  }

  async findCurrent(projectId: string): Promise<GcpConnectionRecord | null> {
    const row = await db.query.gcpConnections.findFirst({
      where: and(
        eq(schema.gcpConnections.projectId, projectId),
        isNull(schema.gcpConnections.revokedAt),
      ),
      orderBy: [
        desc(sql`${schema.gcpConnections.status} = 'connected'`),
        desc(schema.gcpConnections.createdAt),
      ],
    });
    return row ? toDomain(row) : null;
  }

  async prepareMonitoringGrantRemoval(input: {
    connectionId: string;
    gcpProjectId: string;
    readerServiceAccountEmail: string;
  }): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [connection] = await tx
        .select({
          monitoringViewerGrantCreated: schema.gcpConnections.monitoringViewerGrantCreated,
        })
        .from(schema.gcpConnections)
        .where(
          and(
            eq(schema.gcpConnections.id, input.connectionId),
            eq(schema.gcpConnections.gcpProjectId, input.gcpProjectId),
            eq(schema.gcpConnections.readerServiceAccountEmail, input.readerServiceAccountEmail),
            isNull(schema.gcpConnections.revokedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!connection?.monitoringViewerGrantCreated) return false;
      const [remaining] = await tx
        .select({ id: schema.gcpConnections.id })
        .from(schema.gcpConnections)
        .where(
          and(
            eq(schema.gcpConnections.gcpProjectId, input.gcpProjectId),
            eq(schema.gcpConnections.readerServiceAccountEmail, input.readerServiceAccountEmail),
            ne(schema.gcpConnections.id, input.connectionId),
            eq(schema.gcpConnections.status, "connected"),
            isNull(schema.gcpConnections.revokedAt),
          ),
        )
        .orderBy(desc(schema.gcpConnections.createdAt))
        .limit(1)
        .for("update");
      if (!remaining) return true;
      await tx
        .update(schema.gcpConnections)
        .set({ monitoringViewerGrantCreated: true, updatedAt: new Date() })
        .where(eq(schema.gcpConnections.id, remaining.id));
      return false;
    });
  }

  async markProvisioning(id: string): Promise<void> {
    await db
      .update(schema.gcpConnections)
      .set({ status: "provisioning", lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.gcpConnections.id, id),
          notInArray(schema.gcpConnections.status, ["connected", "disconnecting"]),
        ),
      );
  }

  async ensureIngestKey(id: string, projectId: string): Promise<void> {
    const current = await db.query.gcpConnections.findFirst({
      where: eq(schema.gcpConnections.id, id),
      columns: { apiKeyId: true, ingestKeyCiphertext: true, ingestKeyNonce: true },
    });
    if (current?.apiKeyId && current.ingestKeyCiphertext && current.ingestKeyNonce) return;
    const key = await mintApiKey({ projectId, name: "GCP metrics puller" });
    const encrypted = encryptIntegrationSecret(key.plaintext);
    await db
      .update(schema.gcpConnections)
      .set({
        apiKeyId: key.id,
        ingestKeyCiphertext: encrypted.ciphertext,
        ingestKeyNonce: encrypted.nonce,
        ingestKeyKeyVersion: encrypted.keyVersion,
        updatedAt: new Date(),
      })
      .where(eq(schema.gcpConnections.id, id));
  }

  async markConnected(
    id: string,
    result: ProvisionedGcpConnection,
    supersededConnectionId: string | null,
  ): Promise<GcpConnectionRecord> {
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ projectId: schema.gcpConnections.projectId })
        .from(schema.gcpConnections)
        .where(eq(schema.gcpConnections.id, id))
        .limit(1)
        .for("update");
      if (!candidate) throw new Error("GCP connection not found");
      const [project] = await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, candidate.projectId))
        .limit(1)
        .for("update");
      if (!project) throw new Error("GCP project not found");
      const active = await tx
        .select({ id: schema.gcpConnections.id, status: schema.gcpConnections.status })
        .from(schema.gcpConnections)
        .where(
          and(
            eq(schema.gcpConnections.projectId, candidate.projectId),
            ne(schema.gcpConnections.id, id),
            inArray(schema.gcpConnections.status, ["connected", "disconnecting"]),
            isNull(schema.gcpConnections.revokedAt),
          ),
        );
      if (active.some((connection) => connection.status === "disconnecting")) {
        throw new Error("another GCP connection is disconnecting");
      }
      if (active.some((connection) => connection.id !== supersededConnectionId)) {
        throw new Error("another GCP connection completed first");
      }
      const [row] = await tx
        .update(schema.gcpConnections)
        .set({
          gcpProjectNumber: result.gcpProjectNumber,
          topicName: result.topicName,
          subscriptionName: result.subscriptionName,
          logSinkName: result.logSinkName,
          logSinkWriterIdentity: result.logSinkWriterIdentity,
          monitoringViewerGrantCreated: result.monitoringViewerGrantCreated,
          status: "connected",
          lastError: null,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.gcpConnections.id, id))
        .returning();
      if (!row) throw new Error("GCP connection not found");
      if (supersededConnectionId) {
        const [revoked] = await tx
          .update(schema.gcpConnections)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.gcpConnections.id, supersededConnectionId),
              eq(schema.gcpConnections.projectId, row.projectId),
              eq(schema.gcpConnections.status, "connected"),
              isNull(schema.gcpConnections.revokedAt),
            ),
          )
          .returning({ apiKeyId: schema.gcpConnections.apiKeyId });
        if (revoked?.apiKeyId) {
          await tx
            .update(schema.apiKeys)
            .set({ revokedAt: new Date() })
            .where(and(eq(schema.apiKeys.id, revoked.apiKeyId), isNull(schema.apiKeys.revokedAt)));
        }
      }
      return toDomain(row);
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await db
      .update(schema.gcpConnections)
      .set({ status: "failed", lastError: error.slice(0, 2_000), updatedAt: new Date() })
      .where(
        and(
          eq(schema.gcpConnections.id, id),
          notInArray(schema.gcpConnections.status, ["connected", "disconnecting"]),
        ),
      );
  }

  async claimDisconnect(id: string): Promise<GcpConnectionRecord> {
    const [row] = await db
      .update(schema.gcpConnections)
      .set({ status: "disconnecting", updatedAt: new Date() })
      .where(
        and(
          eq(schema.gcpConnections.id, id),
          inArray(schema.gcpConnections.status, ["connected", "failed"]),
          isNull(schema.gcpConnections.revokedAt),
        ),
      )
      .returning();
    if (!row) throw new Error("GCP disconnect is already in progress or unavailable");
    return toDomain(row);
  }

  async releaseDisconnect(id: string, previousStatus: "connected" | "failed"): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [connection] = await tx
        .select({
          projectId: schema.gcpConnections.projectId,
          status: schema.gcpConnections.status,
          revokedAt: schema.gcpConnections.revokedAt,
          apiKeyId: schema.gcpConnections.apiKeyId,
        })
        .from(schema.gcpConnections)
        .where(eq(schema.gcpConnections.id, id))
        .limit(1)
        .for("update");
      if (!connection || connection.status !== "disconnecting" || connection.revokedAt) {
        return false;
      }
      const [project] = await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, connection.projectId))
        .limit(1)
        .for("update");
      if (!project) throw new Error("GCP project not found");
      const [replacement] = await tx
        .select({ id: schema.gcpConnections.id })
        .from(schema.gcpConnections)
        .where(
          and(
            eq(schema.gcpConnections.projectId, connection.projectId),
            ne(schema.gcpConnections.id, id),
            eq(schema.gcpConnections.status, "connected"),
            isNull(schema.gcpConnections.revokedAt),
          ),
        )
        .limit(1);
      if (replacement) {
        const failedAt = new Date();
        await tx
          .update(schema.gcpConnections)
          .set({
            status: "failed",
            lastError: "replacement completed during disconnect recovery",
            updatedAt: failedAt,
          })
          .where(
            and(
              eq(schema.gcpConnections.id, id),
              eq(schema.gcpConnections.status, "disconnecting"),
              isNull(schema.gcpConnections.revokedAt),
            ),
          );
        if (connection.apiKeyId) {
          await tx
            .update(schema.apiKeys)
            .set({ revokedAt: failedAt })
            .where(
              and(eq(schema.apiKeys.id, connection.apiKeyId), isNull(schema.apiKeys.revokedAt)),
            );
        }
        return false;
      }
      const [restored] = await tx
        .update(schema.gcpConnections)
        .set({
          status: previousStatus,
          ...(previousStatus === "connected" ? { lastError: null } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.gcpConnections.id, id),
            eq(schema.gcpConnections.status, "disconnecting"),
            isNull(schema.gcpConnections.revokedAt),
          ),
        )
        .returning({ id: schema.gcpConnections.id });
      return Boolean(restored);
    });
  }

  async failDisconnect(id: string, error: string): Promise<void> {
    await db
      .update(schema.gcpConnections)
      .set({ status: "failed", lastError: error.slice(0, 2_000), updatedAt: new Date() })
      .where(
        and(
          eq(schema.gcpConnections.id, id),
          eq(schema.gcpConnections.status, "disconnecting"),
          isNull(schema.gcpConnections.revokedAt),
        ),
      );
  }

  async revoke(id: string): Promise<GcpConnectionRecord> {
    return db.transaction(async (tx) => {
      const revokedAt = new Date();
      const [row] = await tx
        .update(schema.gcpConnections)
        .set({ revokedAt, updatedAt: revokedAt })
        .where(
          and(
            eq(schema.gcpConnections.id, id),
            eq(schema.gcpConnections.status, "disconnecting"),
            isNull(schema.gcpConnections.revokedAt),
          ),
        )
        .returning();
      if (!row) throw new Error("Connected GCP project not found");
      if (row.apiKeyId) {
        await tx
          .update(schema.apiKeys)
          .set({ revokedAt })
          .where(and(eq(schema.apiKeys.id, row.apiKeyId), isNull(schema.apiKeys.revokedAt)));
      }
      return toDomain(row);
    });
  }

  async updateExcludedLogNames(
    id: string,
    excludedLogNames: string[],
  ): Promise<GcpConnectionRecord> {
    const [row] = await db
      .update(schema.gcpConnections)
      .set({ excludedLogNames, updatedAt: new Date() })
      .where(
        and(
          eq(schema.gcpConnections.id, id),
          eq(schema.gcpConnections.status, "connected"),
          isNull(schema.gcpConnections.revokedAt),
        ),
      )
      .returning();
    if (!row) throw new Error("Connected GCP project not found");
    return toDomain(row);
  }
}
