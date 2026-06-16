import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { generatePersonalAccessToken, hashToken } from "./keys.js";
import { type PersonalAccessToken, personalAccessTokens } from "./schema.js";

export type PatExpiryChoice = "never" | "30d" | "90d";

const PAT_EXPIRY_DAYS: Record<Exclude<PatExpiryChoice, "never">, number> = {
  "30d": 30,
  "90d": 90,
};

export function isPatExpiryChoice(value: unknown): value is PatExpiryChoice {
  return value === "never" || value === "30d" || value === "90d";
}

/**
 * Pure: turn a user-chosen expiry into an absolute timestamp, or null for a
 * token that never expires. `now` is injectable so the choice→Date mapping is
 * testable without mocking the clock.
 */
export function resolvePatExpiry(choice: PatExpiryChoice, now: Date = new Date()): Date | null {
  if (choice === "never") return null;
  const days = PAT_EXPIRY_DAYS[choice];
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export type MintedPersonalAccessToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  /** Full secret — returned exactly once, never persisted in plaintext. */
  plaintext: string;
  projectId: string;
  expiresAt: Date | null;
  createdAt: Date;
};

export async function mintPersonalAccessToken(input: {
  userId: string;
  projectId: string;
  name: string;
  expiry: PatExpiryChoice;
  scope?: string | null;
}): Promise<MintedPersonalAccessToken> {
  const token = generatePersonalAccessToken();
  const [row] = await db
    .insert(personalAccessTokens)
    .values({
      userId: input.userId,
      projectId: input.projectId,
      name: input.name,
      tokenPrefix: token.prefix,
      tokenHash: token.hash,
      scope: input.scope ?? null,
      expiresAt: resolvePatExpiry(input.expiry),
    })
    .returning();
  if (!row) throw new Error("failed to mint personal access token");
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    plaintext: token.plaintext,
    projectId: row.projectId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Look up a personal access token by its plaintext secret and validate it.
 * Returns the row on success, or `{ reason }` explaining why it's not usable.
 */
export async function resolvePersonalAccessToken(
  plaintext: string,
): Promise<PersonalAccessToken | { reason: string }> {
  const row = await db.query.personalAccessTokens.findFirst({
    where: eq(personalAccessTokens.tokenHash, hashToken(plaintext)),
  });
  if (!row) return { reason: "token not found" };
  if (row.revokedAt) return { reason: "token revoked" };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { reason: "token expired" };
  }
  return row;
}

/** Best-effort last-used stamp; callers fire-and-forget. */
export async function touchPersonalAccessToken(id: string): Promise<void> {
  await db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.id, id));
}
