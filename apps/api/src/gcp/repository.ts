import { db, encryptIntegrationSecret, mintApiKey, schema } from "@superlog/db";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
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

  async markProvisioning(id: string): Promise<void> {
    await db
      .update(schema.gcpConnections)
      .set({ status: "provisioning", lastError: null, updatedAt: new Date() })
      .where(and(eq(schema.gcpConnections.id, id), ne(schema.gcpConnections.status, "connected")));
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

  async markConnected(id: string, result: ProvisionedGcpConnection): Promise<GcpConnectionRecord> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.gcpConnections)
        .set({
          gcpProjectNumber: result.gcpProjectNumber,
          topicName: result.topicName,
          subscriptionName: result.subscriptionName,
          logSinkName: result.logSinkName,
          logSinkWriterIdentity: result.logSinkWriterIdentity,
          status: "connected",
          lastError: null,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.gcpConnections.id, id))
        .returning();
      if (!row) throw new Error("GCP connection not found");
      await tx
        .update(schema.gcpConnections)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.gcpConnections.projectId, row.projectId),
            ne(schema.gcpConnections.id, row.id),
            eq(schema.gcpConnections.status, "connected"),
            isNull(schema.gcpConnections.revokedAt),
          ),
        );
      return toDomain(row);
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await db
      .update(schema.gcpConnections)
      .set({ status: "failed", lastError: error.slice(0, 2_000), updatedAt: new Date() })
      .where(and(eq(schema.gcpConnections.id, id), ne(schema.gcpConnections.status, "connected")));
  }
}
