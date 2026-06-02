import type { DB } from "@superlog/db";
import { hashApiKey, isIngestApiKey } from "@superlog/db/keys";
import * as schema from "@superlog/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export async function resolvePublicSourceMapUploadAuth(opts: {
  database: DB;
  method: string;
  path: string;
  token: string;
}): Promise<{ projectId: string; apiKeyId: string } | null> {
  if (!isIngestApiKey(opts.token)) return null;
  if (opts.method.toUpperCase() !== "POST") return null;
  const match = opts.path.match(
    /^\/api\/v1\/projects\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/sourcemaps$/,
  );
  const projectId = match?.[1];
  if (!projectId) return null;

  const row = await opts.database.query.apiKeys.findFirst({
    where: and(
      eq(schema.apiKeys.keyHash, hashApiKey(opts.token)),
      isNull(schema.apiKeys.revokedAt),
    ),
  });
  if (!row || row.projectId !== projectId) return null;
  return { projectId, apiKeyId: row.id };
}
