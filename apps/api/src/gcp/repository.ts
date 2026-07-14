import { db, encryptIntegrationSecret, mintApiKey, schema } from "@superlog/db";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
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
    const [row] = await db.insert(schema.gcpConnections).values(input).returning();
    if (!row) throw new Error("failed to create GCP connection");
    return toDomain(row);
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
      orderBy: desc(schema.gcpConnections.createdAt),
    });
    return row ? toDomain(row) : null;
  }

  async markProvisioning(id: string): Promise<void> {
    await db
      .update(schema.gcpConnections)
      .set({ status: "provisioning", lastError: null, updatedAt: new Date() })
      .where(eq(schema.gcpConnections.id, id));
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
          ...result,
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
      .where(eq(schema.gcpConnections.id, id));
  }
}
