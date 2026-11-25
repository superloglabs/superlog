import { and, eq, isNull } from "drizzle-orm";
import { type DB, db } from "./client.js";
import { generateOrgManagementKey, hashApiKey } from "./keys.js";
import { orgApiKeys } from "./schema.js";
import { userHasActiveBan } from "./user-credentials.js";

export type MintedOrgApiKey = {
  id: string;
  orgId: string;
  name: string;
  keyPrefix: string;
  plaintext: string;
  createdAt: Date;
};

export async function mintOrgApiKey(args: {
  orgId: string;
  name: string;
  createdByUserId?: string | null;
}): Promise<MintedOrgApiKey> {
  const { plaintext, hash, prefix } = generateOrgManagementKey();
  const [row] = await db
    .insert(orgApiKeys)
    .values({
      orgId: args.orgId,
      name: args.name,
      keyHash: hash,
      keyPrefix: prefix,
      createdByUserId: args.createdByUserId ?? null,
    })
    .returning();
  if (!row) throw new Error("failed to mint org api key");
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    plaintext,
    createdAt: row.createdAt,
  };
}

// Looks up an active org api key by plaintext. Returns null if revoked,
// unknown, or created by a user who is currently banned. Updates last_used_at
// as a best-effort side effect (fire-and-forget).
export async function resolveOrgApiKey(
  plaintext: string,
  database: DB = db,
): Promise<{
  id: string;
  orgId: string;
} | null> {
  const hash = hashApiKey(plaintext);
  const row = await database.query.orgApiKeys.findFirst({
    where: and(eq(orgApiKeys.keyHash, hash), isNull(orgApiKeys.revokedAt)),
  });
  if (!row) return null;
  if (row.createdByUserId && (await userHasActiveBan(database, row.createdByUserId))) return null;
  void database
    .update(orgApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(orgApiKeys.id, row.id))
    .catch(() => {});
  return { id: row.id, orgId: row.orgId };
}
