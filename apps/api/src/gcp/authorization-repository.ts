import { db, decryptIntegrationSecret, encryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, lte } from "drizzle-orm";
import type {
  GcpAuthorizationClaim,
  GcpAuthorizationRepository,
  GcpAuthorizationSessionRecord,
} from "./domain.js";
import { GcpAuthorizationError } from "./domain.js";

type Row = typeof schema.gcpAuthorizationSessions.$inferSelect;

function toDomain(row: Row): GcpAuthorizationSessionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    status: row.status,
    projects: row.projects,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleGcpAuthorizationRepository implements GcpAuthorizationRepository {
  async create(input: {
    projectId: string;
    userId: string;
    expiresAt: Date;
  }): Promise<GcpAuthorizationSessionRecord> {
    const [row] = await db.insert(schema.gcpAuthorizationSessions).values(input).returning();
    if (!row) throw new Error("failed to create GCP authorization session");
    return toDomain(row);
  }

  async findById(id: string): Promise<GcpAuthorizationSessionRecord | null> {
    const row = await db.query.gcpAuthorizationSessions.findFirst({
      where: eq(schema.gcpAuthorizationSessions.id, id),
    });
    return row ? toDomain(row) : null;
  }

  async markReady(input: {
    id: string;
    accessToken: string;
    projects: GcpAuthorizationSessionRecord["projects"];
    expiresAt: Date;
  }): Promise<GcpAuthorizationSessionRecord> {
    const encrypted = encryptIntegrationSecret(input.accessToken);
    const [row] = await db
      .update(schema.gcpAuthorizationSessions)
      .set({
        status: "ready",
        projects: input.projects,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenNonce: encrypted.nonce,
        accessTokenKeyVersion: encrypted.keyVersion,
        expiresAt: input.expiresAt,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.gcpAuthorizationSessions.id, input.id),
          eq(schema.gcpAuthorizationSessions.status, "pending"),
        ),
      )
      .returning();
    if (!row) throw new GcpAuthorizationError("unavailable", "GCP authorization is unavailable");
    return toDomain(row);
  }

  async markFailed(id: string, error: string): Promise<void> {
    await db
      .update(schema.gcpAuthorizationSessions)
      .set({
        status: "failed",
        accessTokenCiphertext: null,
        accessTokenNonce: null,
        accessTokenKeyVersion: null,
        lastError: error.slice(0, 2_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.gcpAuthorizationSessions.id, id),
          eq(schema.gcpAuthorizationSessions.status, "pending"),
        ),
      );
  }

  async expire(id: string, now: Date): Promise<void> {
    await db
      .update(schema.gcpAuthorizationSessions)
      .set({
        status: "failed",
        accessTokenCiphertext: null,
        accessTokenNonce: null,
        accessTokenKeyVersion: null,
        lastError: "Google OAuth authorization expired",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.gcpAuthorizationSessions.id, id),
          eq(schema.gcpAuthorizationSessions.status, "ready"),
          lte(schema.gcpAuthorizationSessions.expiresAt, now),
        ),
      );
  }

  async claim(input: {
    id: string;
    projectId: string;
    userId: string;
    gcpProjectId: string;
    now: Date;
  }): Promise<GcpAuthorizationClaim> {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.gcpAuthorizationSessions)
        .where(eq(schema.gcpAuthorizationSessions.id, input.id))
        .limit(1)
        .for("update");
      if (!row || row.projectId !== input.projectId || row.userId !== input.userId) {
        throw new GcpAuthorizationError("not_found", "GCP authorization not found");
      }
      if (row.status === "consumed" || row.consumedAt) {
        throw new GcpAuthorizationError("consumed", "GCP authorization was already used");
      }
      if (row.expiresAt.getTime() <= input.now.getTime()) {
        await tx
          .update(schema.gcpAuthorizationSessions)
          .set({
            status: "failed",
            accessTokenCiphertext: null,
            accessTokenNonce: null,
            accessTokenKeyVersion: null,
            lastError: "Google OAuth authorization expired",
            updatedAt: input.now,
          })
          .where(eq(schema.gcpAuthorizationSessions.id, row.id));
        return {
          error: new GcpAuthorizationError("expired", "GCP authorization expired"),
        } as const;
      }
      if (row.status !== "ready") {
        throw new GcpAuthorizationError("unavailable", "GCP authorization is unavailable");
      }
      const project = row.projects.find((item) => item.projectId === input.gcpProjectId);
      if (!project) {
        throw new GcpAuthorizationError(
          "invalid_selection",
          "Select a project returned by Google Cloud",
        );
      }
      if (
        !row.accessTokenCiphertext ||
        !row.accessTokenNonce ||
        row.accessTokenKeyVersion === null
      ) {
        throw new GcpAuthorizationError("unavailable", "GCP authorization token is unavailable");
      }
      const accessToken = decryptIntegrationSecret({
        ciphertext: row.accessTokenCiphertext,
        nonce: row.accessTokenNonce,
        keyVersion: row.accessTokenKeyVersion,
      });
      const [consumed] = await tx
        .update(schema.gcpAuthorizationSessions)
        .set({
          status: "consumed",
          consumedAt: input.now,
          accessTokenCiphertext: null,
          accessTokenNonce: null,
          accessTokenKeyVersion: null,
          updatedAt: input.now,
        })
        .where(eq(schema.gcpAuthorizationSessions.id, row.id))
        .returning();
      if (!consumed) {
        throw new GcpAuthorizationError("unavailable", "GCP authorization is unavailable");
      }
      return { claim: { session: toDomain(consumed), project, accessToken } } as const;
    });
    if ("error" in result) throw result.error;
    return result.claim;
  }
}
