import { and, asc, eq, sql } from "drizzle-orm";
import { type DB, db } from "./client.js";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "./integration-secrets.js";
import {
  MAX_ENABLED_CUSTOM_MCP_SERVERS,
  type NewProjectMcpServer,
  type ProjectMcpServer,
  type ProjectMcpServerAuth,
  ProjectMcpServerError,
  type ProjectMcpServerRepository,
} from "./project-mcp-servers.js";
import { projectMcpServers } from "./schema.js";

export function createDrizzleProjectMcpServerRepository(
  database: DB = db,
): ProjectMcpServerRepository {
  return {
    async list(projectId) {
      const rows = await database
        .select()
        .from(projectMcpServers)
        .where(eq(projectMcpServers.projectId, projectId))
        .orderBy(asc(projectMcpServers.createdAt));
      return rows.map(toDomain);
    },
    async get(projectId, id) {
      const [row] = await database
        .select()
        .from(projectMcpServers)
        .where(and(eq(projectMcpServers.projectId, projectId), eq(projectMcpServers.id, id)))
        .limit(1);
      return row ? toDomain(row) : null;
    },
    async insert(input) {
      const row = await database.transaction(async (tx) => {
        await lockProject(tx, input.projectId);
        if (input.enabled) await assertEnabledCapacity(tx, input.projectId);
        const [inserted] = await tx.insert(projectMcpServers).values(toInsert(input)).returning();
        return inserted;
      });
      if (!row) throw new Error("failed to create project MCP server");
      return toDomain(row);
    },
    async update(server) {
      const row = await database.transaction(async (tx) => {
        await lockProject(tx, server.projectId);
        const [current] = await tx
          .select({ enabled: projectMcpServers.enabled })
          .from(projectMcpServers)
          .where(
            and(
              eq(projectMcpServers.projectId, server.projectId),
              eq(projectMcpServers.id, server.id),
            ),
          )
          .limit(1);
        if (server.enabled && current && !current.enabled) {
          await assertEnabledCapacity(tx, server.projectId);
        }
        const [updated] = await tx
          .update(projectMcpServers)
          .set(toUpdate(server))
          .where(
            and(
              eq(projectMcpServers.projectId, server.projectId),
              eq(projectMcpServers.id, server.id),
            ),
          )
          .returning();
        return updated;
      });
      if (!row) throw new ProjectMcpServerError("not_found", "MCP server not found");
      return toDomain(row);
    },
    async delete(projectId, id) {
      const rows = await database
        .delete(projectMcpServers)
        .where(and(eq(projectMcpServers.projectId, projectId), eq(projectMcpServers.id, id)))
        .returning({ id: projectMcpServers.id });
      return rows.length > 0;
    },
  };
}

type ProjectMcpTransaction = Parameters<Parameters<DB["transaction"]>[0]>[0];

async function lockProject(tx: ProjectMcpTransaction, projectId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
}

async function assertEnabledCapacity(tx: ProjectMcpTransaction, projectId: string): Promise<void> {
  const [result] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(projectMcpServers)
    .where(and(eq(projectMcpServers.projectId, projectId), eq(projectMcpServers.enabled, true)));
  if ((result?.count ?? 0) >= MAX_ENABLED_CUSTOM_MCP_SERVERS) {
    throw new ProjectMcpServerError(
      "enabled_limit",
      `a project may have at most ${MAX_ENABLED_CUSTOM_MCP_SERVERS} enabled custom MCP servers`,
    );
  }
}

function toInsert(input: NewProjectMcpServer): typeof projectMcpServers.$inferInsert {
  return {
    projectId: input.projectId,
    name: input.name,
    displayName: input.displayName,
    url: input.url,
    enabled: input.enabled,
    authType: input.auth.type,
    ...encryptedAuth(input.auth),
    trustedAt: input.trustedAt,
    trustedByUserId: input.trustedByUserId,
    createdByUserId: input.createdByUserId,
    updatedByUserId: input.updatedByUserId,
  };
}

function toUpdate(server: ProjectMcpServer): Partial<typeof projectMcpServers.$inferInsert> {
  return {
    name: server.name,
    displayName: server.displayName,
    url: server.url,
    enabled: server.enabled,
    authType: server.auth.type,
    ...encryptedAuth(server.auth),
    trustedAt: server.trustedAt,
    trustedByUserId: server.trustedByUserId,
    updatedByUserId: server.updatedByUserId,
    updatedAt: server.updatedAt,
  };
}

function encryptedAuth(auth: ProjectMcpServerAuth): {
  authCiphertext: Buffer | null;
  authNonce: Buffer | null;
  authKeyVersion: number | null;
} {
  if (auth.type === "none") {
    return { authCiphertext: null, authNonce: null, authKeyVersion: null };
  }
  const payload =
    auth.type === "oauth" ? { ...auth, expiresAt: auth.expiresAt?.toISOString() ?? null } : auth;
  const cipher = encryptIntegrationSecret(JSON.stringify(payload));
  return {
    authCiphertext: cipher.ciphertext,
    authNonce: cipher.nonce,
    authKeyVersion: cipher.keyVersion,
  };
}

function toDomain(row: typeof projectMcpServers.$inferSelect): ProjectMcpServer {
  let auth: ProjectMcpServerAuth = { type: "none" };
  if (
    row.authType !== "none" &&
    row.authCiphertext &&
    row.authNonce &&
    row.authKeyVersion !== null
  ) {
    const parsed = JSON.parse(
      decryptIntegrationSecret({
        ciphertext: row.authCiphertext,
        nonce: row.authNonce,
        keyVersion: row.authKeyVersion,
      }),
    ) as ProjectMcpServerAuth & { expiresAt?: string | null };
    auth =
      parsed.type === "oauth"
        ? {
            ...parsed,
            expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
          }
        : parsed;
  }
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    displayName: row.displayName ?? row.name,
    url: row.url,
    enabled: row.enabled,
    auth,
    trustedAt: row.trustedAt,
    trustedByUserId: row.trustedByUserId,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
